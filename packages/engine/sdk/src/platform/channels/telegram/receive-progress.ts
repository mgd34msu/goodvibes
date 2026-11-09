/** Private progress of one actual polling loop. A claim is pinned before the
 * notice is sent and invalidates on any skipped processing or other consumer.
 * Empty responses prove only through their request's start, after dispatch and
 * durable cursor work. This is not durable cross-restart history coverage. */
export class TelegramReceiveCoverageError extends Error {
  constructor() { super('The original Telegram receive span could not be confirmed. Inspect channel status before retrying the purchase.'); this.name = 'TelegramReceiveCoverageError'; }
}
export interface TelegramReceiveScope { readonly conversationId: string; readonly threadId?: string | undefined }
export interface TelegramReceiveSpan {
  waitFor(sinceMs: number, throughMs: number, signal: AbortSignal, scope: TelegramReceiveScope): Promise<() => void>;
}
export interface TelegramReceiveProgressOwner { retain(): TelegramReceiveSpan }
interface Waiting {
  readonly changed: () => void;
}
const RETENTION_MS = 24 * 60 * 60 * 1000;
const validTime = (value: number): boolean => Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;

export class TelegramPollingReceiveProgress implements TelegramReceiveProgressOwner {
  private segment = {};
  private readonly waiting = new Set<Waiting>();
  private closed = false;
  private lastTime: number;
  private since: number;
  private completedAt: number;
  private through = -1;
  private sequence = 0;
  private readonly scopedGaps = new Map<string, number>();
  private readonly onAbort: () => void;

  constructor(private readonly lifetime: AbortSignal, private readonly now: () => number = Date.now) {
    const started = now(); if (!validTime(started)) throw new TelegramReceiveCoverageError();
    this.lastTime = this.since = this.completedAt = started;
    this.onAbort = () => this.close(); lifetime.addEventListener('abort', this.onAbort, { once: true });
    if (lifetime.aborted) this.close();
  }
  private time(): number {
    const now = this.now();
    if (this.closed || this.lifetime.aborted || !validTime(now) || now < this.lastTime) { this.close(); throw new TelegramReceiveCoverageError(); }
    this.lastTime = now; return now;
  }
  private notify(): void { for (const wait of [...this.waiting]) wait.changed(); }
  /** No old claim may cross an update we deliberately skipped or another
   * consumer that might have confirmed updates without our archive. */
  gap(scope?: TelegramReceiveScope): void {
    const now = this.time();
    const key = scope ? JSON.stringify([scope.conversationId, scope.threadId ?? null]) : undefined;
    if (key !== undefined && this.sequence < Number.MAX_SAFE_INTEGER && (this.scopedGaps.size < 256 || this.scopedGaps.has(key))) {
      this.scopedGaps.set(key, ++this.sequence);
    } else {
      this.segment = {}; this.since = now; this.through = -1; this.completedAt = now; this.sequence = 0; this.scopedGaps.clear();
    }
    this.notify();
  }
  beginRequest(): number {
    const now = this.time();
    if (now - this.completedAt >= RETENTION_MS) this.gap();
    return now;
  }
  /** Called only after the actual returned batch has finished dispatch and
   * cursor persistence. Nonempty or full batches never prove queue quiet. */
  completeRequest(startedAtMs: number, empty: boolean): void {
    const now = this.time();
    if (!validTime(startedAtMs) || startedAtMs > now) { this.close(); throw new TelegramReceiveCoverageError(); }
    if (now - this.completedAt >= RETENTION_MS) this.gap();
    this.completedAt = now;
    if (empty && startedAtMs >= this.since) this.through = Math.max(this.through, startedAtMs);
    this.notify();
  }
  /** Keep normal long-polling; a waiting expiry needs only a short positive
   * timeout on the next request, never a concurrent getUpdates consumer. */
  timeoutSeconds(normal: number): number { return this.waiting.size ? 1 : normal; }
  retain(): TelegramReceiveSpan {
    this.time(); const segment = this.segment, sequence = this.sequence;
    return Object.freeze({ waitFor: (sinceMs: number, throughMs: number, signal: AbortSignal, scope: TelegramReceiveScope) => {
      const scopeKey = JSON.stringify([scope.conversationId, scope.threadId ?? null]);
      return new Promise<() => void>((resolve, reject) => {
      let wait: Waiting;
      const cleanup = () => { this.waiting.delete(wait); signal.removeEventListener('abort', changed); };
      const assertCurrent = (ready = false) => {
        const now = this.time();
        const gap = this.scopedGaps.get(scopeKey);
        if (signal.aborted || segment !== this.segment || (gap !== undefined && gap > sequence) || !validTime(sinceMs) || !validTime(throughMs)
          || sinceMs < this.since || throughMs < sinceMs || now - this.completedAt >= RETENTION_MS || ready && this.through < throughMs) throw new TelegramReceiveCoverageError();
      };
      const changed = () => {
        try { assertCurrent(); }
        catch { cleanup(); reject(new TelegramReceiveCoverageError()); return; }
        if (this.through >= throughMs) { cleanup(); resolve(() => assertCurrent(true)); }
      };
      wait = { changed };
      this.waiting.add(wait); signal.addEventListener('abort', changed, { once: true }); changed();
      });
    } });
  }
  close(): void {
    if (this.closed) return; this.closed = true; this.lifetime.removeEventListener('abort', this.onAbort); this.notify();
  }
}
