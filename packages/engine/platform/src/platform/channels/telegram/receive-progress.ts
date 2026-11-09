/** Private progress of one actual polling loop. A claim is pinned before the
 * notice is sent and invalidates on any skipped processing or other consumer.
 * Empty responses prove only through their request's start, after dispatch and
 * durable cursor work. Native payment spans persist under that cursor's real
 * lease; an in-memory span alone never proves cross-restart custody. */
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import type { TelegramPollingCursor } from './offset-store.js';
import { sameTelegramPaymentReceiveSelector, readTelegramPaymentReceiveSelector, TELEGRAM_UPDATE_RETENTION_MS,
  MAX_TELEGRAM_PAYMENT_RECEIVE_SPANS, type TelegramPaymentReceiveSelector, type TelegramPaymentReceiveSpan } from './payment-receive-span.js';
export class TelegramReceiveCoverageError extends Error {
  constructor() { super('The original Telegram receive span could not be confirmed. Inspect channel status before retrying the purchase.'); this.name = 'TelegramReceiveCoverageError'; }
}
export interface TelegramReceiveScope { readonly conversationId: string; readonly threadId?: string | undefined }
export interface TelegramReceiveSpan {
  readonly selector?: TelegramPaymentReceiveSelector;
  waitFor(sinceMs: number, throughMs: number, signal: AbortSignal, scope: TelegramReceiveScope): Promise<() => void>;
}
export interface TelegramReceiveProgressOwner {
  retain(purchaseId?: string, sinceMs?: number): TelegramReceiveSpan;
  restore?(selector: TelegramPaymentReceiveSelector): TelegramReceiveSpan;
  prune?(terminal: (purchaseId: string) => boolean): void;
}
interface Waiting {
  readonly changed: () => void;
}
const RETENTION_MS = TELEGRAM_UPDATE_RETENTION_MS;
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
  private requests = 0;
  private readonly scopedGaps = new Map<string, number>();
  private readonly onAbort: () => void;

  constructor(private readonly lifetime: AbortSignal, private readonly now: () => number = Date.now,
    private readonly cursor?: TelegramPollingCursor) {
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
    this.updateDurable(spans => spans.map(span => {
      if (span.invalid || scope && span.gaps.some(gap => gap.conversationId === scope.conversationId && gap.threadId === scope.threadId)) return span;
      if (!scope || span.gaps.length >= 64) return { ...span, invalid: true };
      return { ...span, gaps: [...span.gaps, { conversationId: scope.conversationId, ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }) }] };
    }));
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
    this.requests++;
    this.updateDurable(spans => spans.map(span => ({ ...span, completedAtMs: Math.max(span.completedAtMs, now),
      invalid: span.invalid || now < span.completedAtMs || now - span.completedAtMs >= RETENTION_MS,
      quietThroughMs: empty && startedAtMs >= span.sinceMs ? Math.max(span.quietThroughMs ?? 0, startedAtMs) : span.quietThroughMs })));
    if (empty && startedAtMs >= this.since) this.through = Math.max(this.through, startedAtMs);
    this.notify();
  }
  /** Keep normal long-polling; a waiting expiry needs only a short positive
   * timeout on the next request, never a concurrent getUpdates consumer. */
  timeoutSeconds(normal: number): number { return this.waiting.size ? 1 : normal; }
  private updateDurable(update: (spans: readonly TelegramPaymentReceiveSpan[]) => readonly TelegramPaymentReceiveSpan[]): void {
    if (!this.cursor) return;
    const spans = this.cursor.receiveSpans();
    if (spans.length) this.cursor.replaceReceiveSpans(update(spans), () => { this.time(); this.cursor?.assertCurrent(); });
  }
  prune(terminal: (purchaseId: string) => boolean): void {
    this.time();
    if (!this.cursor) return;
    const spans = this.cursor.receiveSpans(), retained = spans.filter(span => terminal(span.purchaseId) !== true);
    if (retained.length !== spans.length) this.cursor.replaceReceiveSpans(retained, () => { this.time(); this.cursor?.assertCurrent(); });
  }
  restore(value: TelegramPaymentReceiveSelector): TelegramReceiveSpan {
    const selector = readTelegramPaymentReceiveSelector(value);
    this.readDurable(selector); return this.durableSpan(selector);
  }
  private readDurable(selector: TelegramPaymentReceiveSelector, scope?: TelegramReceiveScope): TelegramPaymentReceiveSpan {
    const now = this.time(), span = this.cursor?.receiveSpans().find(entry => entry.id === selector.id);
    if (!span || !sameTelegramPaymentReceiveSelector(span, selector) || span.invalid || now < span.completedAtMs
      || now - span.completedAtMs >= RETENTION_MS
      || scope && span.gaps.some(gap => gap.conversationId === scope.conversationId && gap.threadId === scope.threadId)) throw new TelegramReceiveCoverageError();
    return span;
  }
  private durableSpan(selector: TelegramPaymentReceiveSelector): TelegramReceiveSpan {
    return Object.freeze({ selector, waitFor: (sinceMs: number, throughMs: number, signal: AbortSignal, scope: TelegramReceiveScope) =>
      new Promise<() => void>((resolve, reject) => {
        const firstRequest = this.requests;
        let wait: Waiting, timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => { this.waiting.delete(wait); signal.removeEventListener('abort', changed); if (timer !== undefined) clearTimeout(timer); };
        const assertion = (complete = false) => {
          if (signal.aborted || !validTime(sinceMs) || !validTime(throughMs) || sinceMs !== selector.sinceMs || throughMs < sinceMs) throw new TelegramReceiveCoverageError();
          const span = this.readDurable(selector, scope);
          if (complete && (span.quietThroughMs === null || span.quietThroughMs < throughMs)) throw new TelegramReceiveCoverageError();
          return span;
        };
        const changed = () => {
          try {
            const span = assertion();
            if (span.quietThroughMs !== null && span.quietThroughMs >= throughMs) { cleanup(); resolve(() => { assertion(true); }); }
            else if (this.requests - firstRequest >= 64) { cleanup(); reject(new TelegramReceiveCoverageError()); }
          } catch { cleanup(); reject(new TelegramReceiveCoverageError()); }
        };
        wait = { changed }; this.waiting.add(wait); signal.addEventListener('abort', changed, { once: true });
        // Bounded backlog draining is not absence evidence. Only an actual
        // empty request started through the target can resolve this claim.
        timer = setTimeout(() => { cleanup(); reject(new TelegramReceiveCoverageError()); }, 30_000);
        changed();
      }) });
  }
  retain(purchaseId?: string, sinceMs?: number): TelegramReceiveSpan {
    if (this.cursor && purchaseId !== undefined) {
      const now = this.time(), since = sinceMs ?? now, captured = this.cursor.capture();
      if (!validTime(since) || since > now || now - since >= RETENTION_MS || !purchaseId || purchaseId.length > 256) throw new TelegramReceiveCoverageError();
      const spans = this.cursor.receiveSpans();
      if (spans.length >= MAX_TELEGRAM_PAYMENT_RECEIVE_SPANS) throw new TelegramReceiveCoverageError();
      const span: TelegramPaymentReceiveSpan = { id: opaqueUuid(), accountId: captured.observation.accountId, purchaseId,
        sinceMs: since, registeredAtMs: now, offsetAtStart: captured.observation.offset, completedAtMs: now,
        quietThroughMs: null, invalid: false, gaps: [] };
      this.cursor.replaceReceiveSpans([...spans, span], () => { this.time(); captured.assertCurrent(); });
      return this.durableSpan(readTelegramPaymentReceiveSelector(span));
    }
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
