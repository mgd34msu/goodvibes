/**
 * reply-inbox.ts, where the owner's answer to a purchase notice arrives.
 *
 * The notifier sends an approval or veto notice over the owner's command
 * channels and then waits (`PaymentReplySource.waitForAnswer`). The daemon's
 * shared channel ingress hook offers every inbound owner message on a
 * command-authority channel to this inbox (daemon/payment-reply.ts), and the
 * inbox reads it against the notice it follows (`readPaymentReply`, a Jev
 * reply reading). A reply that answers settles the wait and is consumed; a
 * reply that does not answer is left to flow on as ordinary conversation.
 *
 * Matching is deliberately narrow, as for work proposals and permission
 * asks: only a window waiting on the channel the message arrived on, and only
 * when exactly one is. With two purchases waiting on one channel a bare "yes"
 * could settle either, so it settles neither; each window then falls to its
 * own silence rule, which is the owner's rule for no answer.
 *
 * The wait resolves null at the deadline, and only then. Null means silence
 * and nothing else (payment-ports.ts). A failed reading, or an owner reply
 * still unresolved at the deadline, fails the wait; neither is silence.
 */
import type { PaymentReplySource, PaymentAnswer } from './notice-delivery.js';
import { readPaymentReply } from './notice-delivery.js';
import { parseCommandAuthorityChannel, type CommandAuthorityChannel, type PaymentAnswerChannel } from './types.js';
import { JudgmentError } from '@goodvibes-jev/judgment';
import type { PaymentWindowView, PaymentWindowAnswer } from './window-view.js';
export type { PaymentWindowView, PaymentWindowAnswer } from './window-view.js';

interface Waiter {
  readonly purchaseId: string;
  readonly windowId: string;
  readonly kind: 'approval' | 'veto';
  readonly channels: readonly CommandAuthorityChannel[];
  readonly notice: string;
  readonly deadlineMs: number;
  readonly abort: AbortController;
  readings: number;
  expire(): void;
  settle(answer: { readonly answer: PaymentAnswer; readonly channel: PaymentAnswerChannel } | null): void;
  cancel(error: Error): void;
}

/** Value-free window failures; failure/cancellation can never mean silence. */
export class PaymentReplyWindowError extends Error {
  readonly code = 'PAYMENT_REPLY_WINDOW_UNAVAILABLE';
  constructor(readonly kind: 'invalid' | 'duplicate' | 'cancelled' | 'settled' | 'unsettled-reply' | 'reading-failed' | 'clock-unavailable' | 'stale') {
    super(`The payment reply window is unavailable: ${kind}.`);
    this.name = 'PaymentReplyWindowError';
  }
}

/** Shutdown is a failed wait, never the silence that can permit a veto purchase. */
export class PaymentReplyInboxClosedError extends Error {
  readonly code = 'PAYMENT_REPLY_INBOX_CLOSED';
  constructor() {
    super('The payment reply inbox was closed before the window could finish.');
    this.name = 'PaymentReplyInboxClosedError';
  }
}

export type PaymentReplyOffer =
  | { readonly consumed: false; readonly reason: 'no-window' | 'several-windows' | 'not-an-answer' | 'decision-model-required' }
  | { readonly consumed: true; readonly answer: PaymentAnswer };

export class PaymentReplyInbox implements PaymentReplySource {
  readonly #waiting = new Map<string, Waiter>();
  readonly #now: () => number;
  readonly #offers = new Set<Promise<PaymentReplyOffer>>();
  #closed = false;
  #closing: Promise<void> | null = null;
  readonly #incarnation = crypto.randomUUID();
  #windowSequence = 0;

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  waitForAnswer(input: Parameters<PaymentReplySource['waitForAnswer']>[0]): ReturnType<PaymentReplySource['waitForAnswer']> {
    const waiting = new Promise<Awaited<ReturnType<PaymentReplySource['waitForAnswer']>>>((resolve, reject) => {
      if (this.#closed) { reject(new PaymentReplyInboxClosedError()); return; }
      const purchaseId = input.purchaseId;
      const kind = input.kind;
      const notice = input.notice;
      const deadlineMs = input.deadlineMs;
      const signal = input.signal;
      if (typeof purchaseId !== 'string' || purchaseId.trim().length === 0 || purchaseId.length > 256
        || (kind !== 'approval' && kind !== 'veto') || typeof notice !== 'string'
        || !Number.isFinite(deadlineMs) || !Array.isArray(input.channels)) {
        reject(new PaymentReplyWindowError('invalid')); return;
      }
      const channels = Object.freeze([...input.channels]);
      if (channels.some(channel => typeof channel !== 'string' || parseCommandAuthorityChannel(channel) !== channel)) {
        reject(new PaymentReplyWindowError('invalid')); return;
      }
      if (this.#waiting.has(purchaseId)) { reject(new PaymentReplyWindowError('duplicate')); return; }
      if (this.#windowSequence >= Number.MAX_SAFE_INTEGER) { reject(new PaymentReplyWindowError('invalid')); return; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const remove = (): boolean => {
        if (!this.current(waiter)) return false;
        this.#waiting.delete(purchaseId);
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        return true;
      };
      const arm = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        const now = this.currentTime();
        if (now === undefined) { waiter.cancel(new PaymentReplyWindowError('clock-unavailable')); return; }
        const remaining = deadlineMs - now;
        if (!Number.isFinite(remaining)) { waiter.cancel(new PaymentReplyWindowError('invalid')); return; }
        // Public callers may supply a deadline beyond setTimeout's range.
        // Recheck the actual clock rather than overflowing into early silence.
        timer = setTimeout(() => waiter.expire(), Math.min(0x7fff_ffff, Math.max(0, remaining)));
      };
      const waiter: Waiter = {
        purchaseId, kind, channels, notice, deadlineMs,
        windowId: `payment-window:${this.#incarnation}:${++this.#windowSequence}`,
        abort: new AbortController(),
        readings: 0,
        expire: () => {
          if (!this.current(waiter)) return;
          const now = this.currentTime();
          if (now === undefined) { waiter.cancel(new PaymentReplyWindowError('clock-unavailable')); return; }
          if (now < deadlineMs) { arm(); return; }
          if (waiter.readings > 0) waiter.cancel(new PaymentReplyWindowError('unsettled-reply'));
          else waiter.settle(null);
        },
        settle: (answer) => {
          if (!remove()) return;
          resolve(answer);
          waiter.abort.abort(new PaymentReplyWindowError('settled'));
        },
        cancel: (error) => {
          if (!remove()) return;
          reject(error);
          waiter.abort.abort(error);
        },
      };
      const onAbort = (): void => waiter.cancel(new PaymentReplyWindowError('cancelled'));
      this.#waiting.set(purchaseId, waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else arm();
    });
    // A host may tear down while a caller has not attached its handler
    // yet. Observe rejection without changing what an awaiting caller receives.
    void waiting.catch(() => {});
    return waiting;
  }

  /**
   * Stop admission, reject waiting windows and drain reply readings already
   * accepted. The owner must await this before releasing its graph. No pending
   * window resolves null here; only its actual deadline can establish silence.
   */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const error = new PaymentReplyInboxClosedError();
    for (const waiter of this.#waiting.values()) waiter.cancel(error);
    this.#closing = Promise.allSettled(this.#offers).then(() => {});
    return this.#closing;
  }

  /** How many windows are waiting for an answer. */
  get pending(): number {
    return this.#waiting.size;
  }

  /** A snapshot of the actual live windows. Polling never creates a delivery
   * report and does not change either window's silence/undeliverable rule. */
  inspect(purchaseId?: string): readonly PaymentWindowView[] {
    this.expireWindows();
    return Object.freeze([...this.#waiting.values()]
      .filter(waiter => purchaseId === undefined || waiter.purchaseId === purchaseId)
      .map(waiter => Object.freeze({ purchaseId: waiter.purchaseId, windowId: waiter.windowId,
        kind: waiter.kind, notice: waiter.notice, deadlineMs: waiter.deadlineMs })));
  }

  /** Host-only addressed answer after current operator authority is checked.
   * The exact window ID is mandatory: an old view cannot answer a new wait.
   * Channel ingress still uses offer() and its separate semantic reading. */
  answer(input: { readonly purchaseId: string; readonly windowId: string; readonly action: 'approve' | 'deny' | 'cancel' }): PaymentWindowAnswer {
    if (this.#closed) throw new PaymentReplyInboxClosedError();
    const waiter = this.#waiting.get(input.purchaseId);
    if (!waiter || waiter.windowId !== input.windowId) throw new PaymentReplyWindowError('stale');
    this.expireWindows();
    if (!this.current(waiter)) throw new PaymentReplyWindowError('stale');
    if (input.action !== 'approve' && input.action !== 'deny' && input.action !== 'cancel') throw new PaymentReplyWindowError('invalid');
    const answer: PaymentAnswer = input.action === 'approve'
      ? waiter.kind === 'approval' ? 'approve' : 'acknowledge'
      : waiter.kind === 'approval' ? 'deny' : 'object';
    waiter.settle({ answer, channel: 'operator' });
    return Object.freeze({ purchaseId: waiter.purchaseId, windowId: waiter.windowId, accepted: true, answer });
  }

  /**
   * Offer an inbound owner message that arrived on `channel`. The caller has
   * already established that the sender is the owner.
   */
  offer(channel: CommandAuthorityChannel, text: string): Promise<PaymentReplyOffer> {
    if (this.#closed) return Promise.resolve({ consumed: false, reason: 'no-window' });
    // Track admission before the judgment port can synchronously request close.
    const work = Promise.resolve().then(() => this.readOffer(channel, text));
    this.#offers.add(work);
    void work.then(() => this.#offers.delete(work), () => this.#offers.delete(work));
    return work;
  }

  private async readOffer(channel: CommandAuthorityChannel, text: string): Promise<PaymentReplyOffer> {
    this.expireWindows();
    const waiting = [...this.#waiting.values()].filter((waiter) => waiter.channels.includes(channel));
    if (waiting.length === 0) return { consumed: false, reason: 'no-window' };
    if (waiting.length > 1) return { consumed: false, reason: 'several-windows' };
    const [waiter] = waiting as [Waiter];
    waiter.readings++;
    try {
      const answer = await readPaymentReply(text, waiter.kind, waiter.notice, waiter.abort.signal);
      // A late result cannot revive this window, nor a later wait reusing its ID.
      if (!this.current(waiter)) return { consumed: false, reason: 'no-window' };
      const answeredAt = this.currentTime();
      if (answeredAt === undefined) { waiter.cancel(new PaymentReplyWindowError('clock-unavailable')); return { consumed: false, reason: 'no-window' }; }
      if (answeredAt >= waiter.deadlineMs) { waiter.expire(); return { consumed: false, reason: 'no-window' }; }
      if (answer === null) return { consumed: false, reason: 'not-an-answer' };
      waiter.settle({ answer, channel });
      return { consumed: true, answer };
    } catch (error) {
      if (!this.current(waiter) && (error === waiter.abort.signal.reason || (error instanceof JudgmentError && error.kind === 'aborted')))
        return { consumed: false, reason: 'no-window' };
      // A reply arrived but could not be interpreted. Allowing the veto timer
      // to call this silence would spend while the decision layer is unavailable.
      if (this.current(waiter)) waiter.cancel(new PaymentReplyWindowError('reading-failed'));
      throw error;
    } finally { waiter.readings--; }
  }

  private current(waiter: Waiter): boolean { return this.#waiting.get(waiter.purchaseId) === waiter; }

  private expireWindows(): void {
    const now = this.currentTime();
    for (const waiter of [...this.#waiting.values()]) {
      if (now === undefined) waiter.cancel(new PaymentReplyWindowError('clock-unavailable'));
      else if (now >= waiter.deadlineMs) waiter.expire();
    }
  }

  private currentTime(): number | undefined {
    try { const now = this.#now(); return Number.isFinite(now) ? now : undefined; }
    catch { return undefined; }
  }
}
