/** Keep a current trigger-store lease until all admitted async work has actually
 * completed. A caller-visible cancellation is not proof that a start/effect
 * callback has drained. This is local ownership, not authority over old code.
 */
import { logger } from '../utils/logger.js';
import { TriggerStoreError } from './store-owner.js';
import type { TriggerProcessHost } from './process-triggers.js';
import type { TriggerStreamHost } from './manager-types.js';
import type { StreamRuntime } from './manager-streams.js';
export class TriggerManagerWork {
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  private resourcesStopped = false;
  private stopping: Promise<void> | undefined;
  constructor(private readonly release: () => void) {}
  get stopped(): boolean { return this.closed; }
  start(): void { if (!this.closed) return; if (this.pending.size > 0 || !this.resourcesStopped) throw new TriggerStoreError('unavailable'); this.closed = false; this.resourcesStopped = false; this.stopping = undefined; }
  own<T>(begin: () => Promise<T>): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    this.pending.add(promise);
    const drained = () => { this.pending.delete(promise); };
    void promise.then(drained, drained);
    try { void Promise.resolve(begin()).then(resolve, reject); } catch (error) { reject(error); }
    return promise;
  }
  private async joinPending(): Promise<void> { while (this.pending.size > 0) await Promise.allSettled([...this.pending]); }
  async join(): Promise<void> { await this.joinPending(); await this.stopping; }
  stop(): void { this.closed = true; }
  finishStop(drain?: (() => Promise<void>) | undefined): void {
    if (this.stopping || this.resourcesStopped) return;
    if (!drain && this.pending.size === 0) { this.releaseOwned(); this.resourcesStopped = true; return; }
    this.stopping = (async () => {
      // A late admitted start must hand its actual native child to the host
      // before the host drains; otherwise the executor lease could be released
      // while that child is still being prepared.
      await this.joinPending();
      await drain?.();
      this.releaseOwned();
      this.resourcesStopped = true;
    })();
    void this.stopping.catch(() => logger.warn('Trigger resources could not be drained; executor lease retained'));
  }
  private releaseOwned(): void {
    try { this.release(); } catch { logger.warn('Trigger store lease could not be released from its original directory'); throw new TriggerStoreError('unavailable'); }
  }
}

/** Stop every stream independently. Capture original host joins before awaiting
 * late starts, and never close the shared runtime's unrelated processes. */
export function stopTriggerResources(
  streams: Map<string, StreamRuntime>, streamHost: TriggerStreamHost | undefined,
  processHost: TriggerProcessHost | undefined,
): () => Promise<void> {
  let failed = false;
  for (const [id, runtime] of streams) {
    if (runtime.timer) clearInterval(runtime.timer);
    streams.delete(id);
    const streamId = runtime.streamId; runtime.streamId = null;
    try { if (streamId) streamHost?.stop(streamId); } catch { failed = true; }
  }
  const streamJoin = streamHost?.join?.bind(streamHost), processJoin = processHost?.join?.bind(processHost);
  return async () => {
    const results = await Promise.allSettled([streamJoin, processJoin].map(async (join) => { await join?.(); }));
    if (failed || results.some((result) => result.status === 'rejected')) throw new TriggerStoreError('unavailable');
  };
}
