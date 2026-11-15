/** Host-local custody of original native process handles. Public process IDs
 * select only children of this host; they never grant another manager's job. */
import type { BgCommandResult, ManagedProcessLifetime, ProcessManager } from '../tools/shared/process-manager.js';
import { logger } from '../utils/logger.js';

export class TriggerChildProcesses {
  private readonly children = new Map<string, ManagedProcessLifetime>();
  private readonly launches = new Set<Promise<unknown>>();
  private readonly watchers = new Set<Promise<void>>();
  private readonly stops = new Map<string, Promise<void>>();
  private draining: Promise<void> | undefined;
  /** A drain that could not be confirmed leaves children unaccounted for, so no new child is admitted until a retried join succeeds. */
  private drainFailed = false;
  constructor(private readonly manager: ProcessManager) {}

  admit<T>(begin: () => Promise<T>): Promise<T> {
    if (this.draining || this.drainFailed) return Promise.reject(new Error(this.draining ? 'Trigger process host is draining' : 'Trigger process host drain was not confirmed; call join() again before launching'));
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    this.launches.add(promise);
    const done = () => { this.launches.delete(promise); };
    void promise.then(done, done);
    try { void Promise.resolve(begin()).then(resolve, reject); } catch (error) { reject(error); }
    return promise;
  }

  capture(result: BgCommandResult): ManagedProcessLifetime {
    const original = this.manager.captureProcessLifetime(result);
    this.children.set(original.processId, original);
    return original;
  }
  get(id: string): ManagedProcessLifetime | undefined { return this.children.get(id); }
  release(id: string): void {
    const original = this.children.get(id);
    if (original && !original.readStatus().running && !this.stops.has(id)) this.children.delete(id);
  }

  watch(original: ManagedProcessLifetime, begin: () => Promise<void>): void {
    const task = begin();
    this.watchers.add(task);
    void task.then(() => {
      this.watchers.delete(task);
      this.children.delete(original.processId);
    }, () => {
      // Retain a failed watcher and its child: join must report uncertain drain.
      logger.warn('Trigger child output or completion observer failed');
    });
  }

  stop(id: string): void {
    const original = this.children.get(id);
    if (!original || this.stops.has(id)) return;
    let stopped: Promise<void>;
    try { stopped = original.stop(); } catch { stopped = Promise.reject(new Error('Trigger child termination could not be confirmed')); }
    this.stops.set(id, stopped);
    void stopped.then(() => {
      this.children.delete(id); this.stops.delete(id);
    // The child stays in `children` and the failed stop is forgotten, so a retried join() asks it to stop again.
    }, () => { this.stops.delete(id); logger.warn('Trigger child termination could not be confirmed'); });
  }

  join(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      // Late native spawn admission is still ours, even when its caller stopped.
      while (this.launches.size > 0) await Promise.allSettled([...this.launches]);
      for (const id of this.children.keys()) this.stop(id);
      const results = await Promise.allSettled([
        ...this.stops.values(), ...this.watchers,
        ...[...this.children.values()].map((original) => original.completion),
      ]);
      if (results.some((result) => result.status === 'rejected')) {
        throw new Error('Trigger child drainage could not be confirmed');
      }
      this.children.clear(); this.stops.clear(); this.watchers.clear();
    })();
    // A successful drain allows a deliberate supervisor restart with the same host;
    // a failed one stays refused but can be retried by calling join() again.
    void this.draining.then(() => { this.draining = undefined; this.drainFailed = false; }, () => { this.draining = undefined; this.drainFailed = true; });
    return this.draining;
  }
}
