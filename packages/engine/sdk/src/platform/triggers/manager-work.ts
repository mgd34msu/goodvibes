/** Keep a current trigger-store lease until all admitted async work has actually
 * completed. A caller-visible cancellation is not proof that a start/effect
 * callback has drained. This is local ownership, not authority over old code.
 */
import { logger } from '../utils/logger.js';
import { TriggerStoreError } from './store-owner.js';
export class TriggerManagerWork {
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  private resourcesStopped = false;
  constructor(private readonly release: () => void) {}
  get stopped(): boolean { return this.closed; }
  start(): void { if (!this.closed) return; if (this.pending.size > 0 || !this.resourcesStopped) throw new TriggerStoreError('unavailable'); this.closed = false; this.resourcesStopped = false; }
  own<T>(begin: () => Promise<T>): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    this.pending.add(promise);
    const drained = () => { this.pending.delete(promise); if (this.closed && this.resourcesStopped && this.pending.size === 0) this.releaseOwned(); };
    void promise.then(drained, drained);
    try { void Promise.resolve(begin()).then(resolve, reject); } catch (error) { reject(error); }
    return promise;
  }
  async join(): Promise<void> { while (this.pending.size > 0) await Promise.allSettled([...this.pending]); }
  stop(): void { this.closed = true; }
  finishStop(): void { this.resourcesStopped = true; if (this.pending.size === 0) this.releaseOwned(); }
  private releaseOwned(): void {
    try { this.release(); } catch { logger.warn('Trigger store lease could not be released from its original directory'); }
  }
}
