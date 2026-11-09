/** Bound admitted incoming group work before creating deferred handlers.
 * UDP permits loss; overload drops new datagrams rather than retaining private
 * body queues, evicting entered writes or stalling explicit operator methods.
 */
import type { ClusterLogger } from './types.js';
export const MAX_ACTIVE_GROUP_MESSAGES = 32;
export class ClusterIngressWork {
  private readonly pending = new Set<Promise<void>>();
  private closed = true;
  private dropped = 0;
  private nextDiagnosticAt = 0;
  constructor(private readonly logger: ClusterLogger, private readonly now: () => number, private readonly limit = MAX_ACTIVE_GROUP_MESSAGES) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new RangeError('Invalid cluster incoming work limit');
  }
  open(): void {
    if (this.closed && this.pending.size > 0) throw new Error('Original incoming cluster work is still draining');
    this.closed = false;
  }
  close(): void { this.closed = true; }
  get status(): { readonly active: number; readonly dropped: number } { return { active: this.pending.size, dropped: this.dropped }; }
  admit(begin: () => Promise<void>): boolean {
    if (this.closed) return false;
    if (this.pending.size >= this.limit) {
      this.dropped = Math.min(Number.MAX_SAFE_INTEGER, this.dropped + 1);
      const now = this.now();
      if (now >= this.nextDiagnosticAt) {
        this.nextDiagnosticAt = now + 60_000;
        try { this.logger.warn('cluster: incoming group work limit reached; excess datagrams were dropped'); }
        catch { /* Diagnostics cannot open an execution slot. */ }
      }
      return false;
    }
    // Register before entering a borrowed callback, including reentrant stop.
    const { promise, resolve, reject } = Promise.withResolvers<void>(); this.pending.add(promise);
    const drained = () => { this.pending.delete(promise); }; void promise.then(drained, drained);
    try { void Promise.resolve(begin()).then(resolve, reject); } catch (error) { reject(error); }
    return true;
  }
  async join(): Promise<void> { while (this.pending.size > 0) await Promise.allSettled([...this.pending]); }
}
