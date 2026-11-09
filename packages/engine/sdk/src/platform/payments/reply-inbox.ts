/**
 * reply-inbox.ts, where the owner's answer to a purchase notice arrives.
 *
 * The native notifier reserves reception before sending an approval or veto
 * notice, then arms its window after the delivery report is durable. The daemon's
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
 * The wait can resolve null only after the deadline. Native Telegram waits
 * also require the original poller to finish receiving through that deadline.
 * Null means silence and nothing else (payment-ports.ts). A failed reading or
 * unconfirmed receive span fails the wait; neither is silence.
 */
import type { PaymentReplySource, PaymentAnswer, PreparedPaymentReply } from './notice-delivery.js';
import { readPaymentReply } from './notice-delivery.js';
import { parseCommandAuthorityChannel, type CommandAuthorityChannel, type PaymentAnswerChannel } from './types.js';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { JudgmentPortMissingError, DecisionModelsDisabledError } from '@goodvibes-jev/engine/errors';
import type { ChannelDeliveryReceipt } from '../channels/delivery/types.js';
import { capturePaymentNoticeReceipt, matchesPaymentNoticeReceipt as matchesReceipt } from './notice-receipt.js';
import { PaymentReplyHistoryOwner, type RetainedPaymentReplyHistory } from './reply-history-owner.js';
import type { CheckoutWindowCheckpoint } from './checkout-window-checkpoint.js';
import { PaymentReplyHistoryError, type PaymentReplyHistoryEntry, type PaymentReplyReceiveCoverage } from './reply-history.js';
import type { ChannelDelivery } from './windows.js';
import type { PaymentWindowView, PaymentWindowAnswer } from './window-view.js';
import type { TelegramSourceAccountReader } from '../channels/telegram/source-account.js';
import { PaymentReplySourceOwner, type PaymentReplySourceGuard } from './reply-source-owner.js';
export type { PaymentWindowView, PaymentWindowAnswer } from './window-view.js';

interface Waiter {
  readonly requireDeliveryReceipt: boolean;
  receipts: ReadonlyMap<CommandAuthorityChannel, ChannelDeliveryReceipt>;
  readonly purchaseId: string;
  readonly windowId: string;
  readonly kind: 'approval' | 'veto';
  readonly channels: readonly CommandAuthorityChannel[];
  readonly notice: string;
  deadlineMs: number | undefined;
  armedChannels: readonly CommandAuthorityChannel[] | undefined;
  readonly receptionReady: Promise<void>;
  readonly abort: AbortController;
  readings: number;
  source: PaymentReplySourceGuard | undefined;
  coverage?: Promise<() => void>;
  expire(): void;
  settle(answer: { readonly answer: PaymentAnswer; readonly channel: PaymentAnswerChannel } | null): void;
  cancel(error: Error): void;
}

/** Value-free window failures; failure/cancellation can never mean silence. */
export class PaymentReplyWindowError extends Error {
  readonly code = 'PAYMENT_REPLY_WINDOW_UNAVAILABLE';
  constructor(readonly kind: 'invalid' | 'duplicate' | 'cancelled' | 'settled' | 'unsettled-reply' | 'reading-failed' | 'source-unavailable' | 'receive-uncovered' | 'coverage-unrecorded' | 'history-unavailable' | 'clock-unavailable' | 'stale') {
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
  | { readonly consumed: false; readonly reason: 'no-window' | 'several-windows' | 'not-an-answer' | 'decision-model-required' | 'recorded' }
  | { readonly consumed: true; readonly answer: PaymentAnswer };

/** Host-read ingress facts. Account custody is checked by the original
 * transport owner before and after the semantic reading, never by JSON IDs. */
export interface PaymentReplyCorrelation {
  readonly userId?: string | undefined;
  readonly updateId?: string | undefined;
  readonly sentAtMs?: number | undefined;
  readonly conversationId: string;
  readonly threadId?: string | undefined;
  readonly accountId?: string | undefined;
  readonly messageId?: string | undefined;
  readonly replyToMessageId?: string | undefined;
  readonly assertCurrent?: (() => void) | undefined;
  /** Deferred until this exact wait owns the reading, including its timer. */
  readonly verifyAccount?: (() => Promise<{ readonly accountId: string; readonly assertCurrent: () => void }>) | undefined;
}

export class PaymentReplyInbox implements PaymentReplySource {
  readonly #waiting = new Map<string, Waiter>();
  readonly #now: () => number;
  readonly #offers = new Set<Promise<PaymentReplyOffer>>();
  #closed = false;
  #closing: Promise<void> | null = null;
  readonly #incarnation = crypto.randomUUID();
  #windowSequence = 0;
  readonly #sources = new PaymentReplySourceOwner();
  readonly #history = new PaymentReplyHistoryOwner();

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  /** Composition-only binding to the same ingress owner used for channel
   * replies. Rebinding retires prior preparations; it does no provider I/O. */
  bindTelegramSource(reader: TelegramSourceAccountReader | undefined, lifetime: AbortSignal): void {
    this.#sources.bindTelegram(reader, lifetime);
  }

  retainReplyHistory(purchaseId: string, checkpoint: CheckoutWindowCheckpoint,
    append: (entry: PaymentReplyHistoryEntry, assertCurrent: () => void) => Promise<void>, assertCurrent: () => void,
    recordCoverage?: (coverage: PaymentReplyReceiveCoverage, assertCurrent: () => void) => Promise<void>): RetainedPaymentReplyHistory {
    if (this.#closed) throw new PaymentReplyInboxClosedError();
    return this.#history.retain(purchaseId, checkpoint, append, assertCurrent, recordCoverage);
  }

  /** Construction-only recovery preflight. A stored receipt identifies the
   * required account; the original native source owner supplies the capability.
   * This neither opens a window nor establishes historical receive coverage. */
  async retainTelegramReceipt(receipt: ChannelDeliveryReceipt, owner: { readonly signal: AbortSignal; readonly assertCurrent: () => void }): Promise<{ assertCurrent(): void }> {
    const captured = capturePaymentNoticeReceipt(receipt, 'telegram');
    owner.signal.throwIfAborted(); owner.assertCurrent();
    if (!captured) throw new PaymentReplyWindowError('source-unavailable');
    const source = this.#sources.reserveTelegram(owner.signal);
    await source.ready; owner.signal.throwIfAborted(); owner.assertCurrent(); source.assertReceiptCurrent(captured);
    return Object.freeze({ assertCurrent: () => { owner.signal.throwIfAborted(); owner.assertCurrent(); source.assertReceiptCurrent(captured); } });
  }

  waitForAnswer(input: Parameters<PaymentReplySource['waitForAnswer']>[0]): ReturnType<PaymentReplySource['waitForAnswer']> {
    try {
      const deadlineMs = input.deadlineMs;
      const prepared = this.prepareAnswer(input);
      return prepared.waitForAnswer({ deadlineMs, channels: input.channels, deliveries: input.deliveries });
    } catch (error) {
      const rejected = Promise.reject<Awaited<ReturnType<PaymentReplySource['waitForAnswer']>>>(error);
      void rejected.catch(() => {});
      return rejected;
    }
  }

  /** Reserve the exact purchase before delivery starts. Early channel offers
   * remain owned here until the actual delivered channels/deadline are armed;
   * an unarmed reservation is never an answerable operator window or silence. */
  prepareAnswer(input: Omit<Parameters<PaymentReplySource['waitForAnswer']>[0], 'deadlineMs'>): PreparedPaymentReply {
    if (this.#closed) throw new PaymentReplyInboxClosedError();
    const purchaseId = input.purchaseId;
    const kind = input.kind;
    const notice = input.notice;
    const signal = input.signal;
    const requireDeliveryReceipt = input.requireDeliveryReceipt === true;
    if (typeof purchaseId !== 'string' || purchaseId.trim().length === 0 || purchaseId.length > 256
      || (kind !== 'approval' && kind !== 'veto') || typeof notice !== 'string'
      || !Array.isArray(input.channels)) throw new PaymentReplyWindowError('invalid');
    const channels = Object.freeze([...input.channels]);
    if (channels.some(channel => typeof channel !== 'string' || parseCommandAuthorityChannel(channel) !== channel)) throw new PaymentReplyWindowError('invalid');
    if (this.#waiting.has(purchaseId)) throw new PaymentReplyWindowError('duplicate');
    if (this.#windowSequence >= Number.MAX_SAFE_INTEGER) throw new PaymentReplyWindowError('invalid');
    let resolve!: (answer: Awaited<ReturnType<PaymentReplySource['waitForAnswer']>>) => void;
    let reject!: (error: Error) => void;
    const waiting = new Promise<Awaited<ReturnType<PaymentReplySource['waitForAnswer']>>>((done, failed) => { resolve = done; reject = failed; });
    void waiting.catch(() => {});
    let publishReception!: () => void;
    const receptionReady = new Promise<void>(ready => { publishReception = ready; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const remove = (): boolean => {
      if (!this.current(waiter)) return false;
      this.#waiting.delete(purchaseId);
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // Unblock accepted early offers even when sending/flush/owner failed.
      publishReception();
      return true;
    };
    const armTimer = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      const deadlineMs = waiter.deadlineMs;
      if (deadlineMs === undefined || !this.current(waiter)) return;
      const now = this.currentTime();
      if (now === undefined) { waiter.cancel(new PaymentReplyWindowError('clock-unavailable')); return; }
      const remaining = deadlineMs - now;
      if (!Number.isFinite(remaining)) { waiter.cancel(new PaymentReplyWindowError('invalid')); return; }
      // Public callers may supply a deadline beyond setTimeout's range.
      // Recheck the actual clock rather than overflowing into early silence.
      timer = setTimeout(() => waiter.expire(), Math.min(0x7fff_ffff, Math.max(0, remaining)));
    };
    const waiter: Waiter = {
      requireDeliveryReceipt, receipts: new Map(),
      purchaseId, kind, channels, notice, deadlineMs: undefined, armedChannels: undefined, receptionReady,
      windowId: `payment-window:${this.#incarnation}:${++this.#windowSequence}`,
      abort: new AbortController(),
      readings: 0,
      source: undefined,
      expire: () => {
        if (!this.current(waiter)) return;
        const deadlineMs = waiter.deadlineMs;
        if (deadlineMs === undefined) return;
        const now = this.currentTime();
        if (now === undefined) { waiter.cancel(new PaymentReplyWindowError('clock-unavailable')); return; }
        if (now < deadlineMs) { armTimer(); return; }
        if (waiter.requireDeliveryReceipt && waiter.armedChannels?.some(channel => !waiter.receipts.get(channel)?.accountId)) { waiter.cancel(new PaymentReplyWindowError('source-unavailable')); return; }
        if (waiter.requireDeliveryReceipt && waiter.armedChannels?.includes('telegram')) {
          const source = waiter.source;
          try {
            if (!source) throw new Error();
            source.assertReceiptCurrent(waiter.receipts.get('telegram'));
          } catch { waiter.cancel(new PaymentReplyWindowError('source-unavailable')); return; }
          if (!source) { waiter.cancel(new PaymentReplyWindowError('source-unavailable')); return; }
          if (!waiter.coverage) {
            const receipt = waiter.receipts.get('telegram');
            waiter.coverage = source.waitForCoverage(receipt, deadlineMs);
            void waiter.coverage.then(async covered => {
              if (!this.current(waiter)) return;
              const now = this.currentTime();
              if (now === undefined || now < deadlineMs) { waiter.cancel(new PaymentReplyWindowError('clock-unavailable')); return; }
              if (waiter.readings > 0) { waiter.cancel(new PaymentReplyWindowError('unsettled-reply')); return; }
              const current = () => {
                if (!this.current(waiter) || waiter.source !== source) throw new Error();
                source.assertReceiptCurrent(receipt); covered();
                if (waiter.readings > 0) throw new PaymentReplyWindowError('unsettled-reply');
              };
              try { current(); }
              catch { waiter.cancel(new PaymentReplyWindowError('source-unavailable')); return; }
              try {
                if (!receipt) throw new PaymentReplyWindowError('source-unavailable');
                await this.#history.recordReceiveCoverage(waiter.purchaseId, { resolution: 'silence', receipt, throughMs: deadlineMs, checkedAtMs: now }, current);
                current(); waiter.settle(null);
              } catch (error) {
                if (this.current(waiter)) waiter.cancel(new PaymentReplyWindowError(error instanceof PaymentReplyHistoryError ? 'coverage-unrecorded' : 'source-unavailable'));
              }
            }, () => {
              if (!this.current(waiter)) return;
              try { if (waiter.source !== source) throw new Error(); source.assertReceiptCurrent(receipt); }
              catch { waiter.cancel(new PaymentReplyWindowError('source-unavailable')); return; }
              waiter.cancel(new PaymentReplyWindowError('receive-uncovered'));
            });
          }
          return;
        }
        if (waiter.readings > 0) { waiter.cancel(new PaymentReplyWindowError('unsettled-reply')); return; }
        waiter.settle(null);
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
    if (requireDeliveryReceipt && channels.includes('telegram') && this.current(waiter)) {
      waiter.source = this.#sources.reserveTelegram(waiter.abort.signal, this.currentTime() ?? Number.NaN);
    }
    return Object.freeze({
      waitForAnswer: (armed: { readonly deadlineMs: number; readonly channels: readonly CommandAuthorityChannel[]; readonly deliveries?: readonly ChannelDelivery[] | undefined }) => {
        if (!this.current(waiter)) return waiting;
        if (waiter.deadlineMs !== undefined) throw new PaymentReplyWindowError('duplicate');
        let deadlineMs: number, deliveredChannels: readonly CommandAuthorityChannel[];
        try {
          deadlineMs = armed.deadlineMs;
          const selectedChannels = armed.channels;
          if (!Number.isFinite(deadlineMs) || !Array.isArray(selectedChannels)) throw new PaymentReplyWindowError('invalid');
          deliveredChannels = Object.freeze([...selectedChannels]);
          if (deliveredChannels.some(channel => !channels.includes(channel))) throw new PaymentReplyWindowError('invalid');
        } catch {
          waiter.cancel(new PaymentReplyWindowError('invalid')); return waiting;
        }
        const receipts = new Map<CommandAuthorityChannel, ChannelDeliveryReceipt>();
        try {
          if (armed.deliveries !== undefined && (!Array.isArray(armed.deliveries) || armed.deliveries.length > 256)) throw new PaymentReplyWindowError('invalid');
          for (const delivery of armed.deliveries ?? []) {
            if (!delivery.delivered || !deliveredChannels.includes(delivery.channel)) continue;
            const receipt = capturePaymentNoticeReceipt(delivery.receipt, delivery.channel);
            if (receipt) receipts.set(delivery.channel, receipt);
          }
        } catch { waiter.cancel(new PaymentReplyWindowError('invalid')); return waiting; }
        waiter.deadlineMs = deadlineMs;
        waiter.receipts = receipts;
        waiter.armedChannels = Object.freeze([...new Set(deliveredChannels)]);
        publishReception();
        armTimer();
        return waiting;
      },
      cancel: () => { waiter.cancel(new PaymentReplyWindowError('cancelled')); },
    });
  }

  /**
   * Stop admission, reject waiting windows and drain reply readings already
   * accepted. The owner must await this before releasing its graph. No pending
   * window resolves null here; only its actual deadline can establish silence.
   */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    let finish!: () => void;
    this.#closing = new Promise<void>(done => { finish = done; });
    this.#closed = true;
    const error = new PaymentReplyInboxClosedError();
    for (const waiter of this.#waiting.values()) waiter.cancel(error);
    void Promise.allSettled([...this.#offers, this.#sources.close(), this.#history.close()]).then(() => finish());
    return this.#closing;
  }

  /** Reserved receptions plus armed windows. Channel ingress must also offer
   * replies while sending; inspect() returns only the armed operator windows. */
  get pending(): number {
    return this.#history.pending + [...this.#waiting.keys()].filter(id => !this.#history.has(id)).length;
  }

  /** A snapshot of the actual live windows. Polling never creates a delivery
   * report and does not change either window's silence/undeliverable rule. */
  inspect(purchaseId?: string): readonly PaymentWindowView[] {
    this.expireWindows();
    return Object.freeze([...this.#waiting.values()]
      .filter(waiter => purchaseId === undefined || waiter.purchaseId === purchaseId)
      .flatMap(waiter => waiter.deadlineMs === undefined || waiter.coverage !== undefined ? [] : [Object.freeze({ purchaseId: waiter.purchaseId, windowId: waiter.windowId,
        kind: waiter.kind, notice: waiter.notice, deadlineMs: waiter.deadlineMs })]));
  }

  /** Host-only addressed answer after current operator authority is checked.
   * The exact window ID is mandatory: an old view cannot answer a new wait.
   * Channel ingress still uses offer() and its separate semantic reading. */
  answer(input: { readonly purchaseId: string; readonly windowId: string; readonly action: 'approve' | 'deny' | 'cancel' }): PaymentWindowAnswer {
    if (this.#closed) throw new PaymentReplyInboxClosedError();
    const waiter = this.#waiting.get(input.purchaseId);
    if (!waiter || waiter.deadlineMs === undefined || waiter.windowId !== input.windowId) throw new PaymentReplyWindowError('stale');
    const now = this.currentTime();
    if (now === undefined) { waiter.cancel(new PaymentReplyWindowError('clock-unavailable')); throw new PaymentReplyWindowError('stale'); }
    if (now >= waiter.deadlineMs) { waiter.expire(); throw new PaymentReplyWindowError('stale'); }
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
  offer(channel: CommandAuthorityChannel, text: string, correlation?: PaymentReplyCorrelation, options: { readonly archiveOnly?: boolean } = {}): Promise<PaymentReplyOffer> {
    if (this.#closed) return Promise.resolve({ consumed: false, reason: 'no-window' });
    const receivedAtMs = this.currentTime();
    this.expireWindows();
    if (this.#closed) return Promise.resolve({ consumed: false, reason: 'no-window' });
    const context = correlation === undefined ? undefined : Object.freeze({ ...correlation });
    const waiting = [...this.#waiting.values()].filter(waiter => {
      if (!(waiter.armedChannels ?? waiter.channels).includes(channel)) return false;
      const receipt = waiter.receipts.get(channel);
      return !context || !receipt || matchesReceipt(receipt, context);
    });
    if (waiting.length === 0 || options.archiveOnly) {
      const work = Promise.resolve().then(async (): Promise<PaymentReplyOffer> => {
        const recorded = channel === 'telegram' && await this.#history.record(text, context, receivedAtMs ?? Number.NaN);
        if (options.archiveOnly) {
          // Retain potential owner objections even while Classic is selected.
          // Ordinary chat still reaches its conversation; only an explicit
          // notice reply gets a storage-only acknowledgement. An uninterpreted
          // owner message cannot later become quiet expiry of a live purchase.
          for (const waiter of waiting) waiter.cancel(new DecisionModelsDisabledError('interpreting a purchase approval or veto reply'));
          if (context?.replyToMessageId === undefined) return { consumed: false, reason: 'decision-model-required' };
        }
        if (recorded) return { consumed: false, reason: 'recorded' };
        return { consumed: false, reason: options.archiveOnly ? 'decision-model-required' : 'no-window' };
      });
      this.#offers.add(work); void work.then(() => this.#offers.delete(work), () => this.#offers.delete(work)); return work;
    }
    if (waiting.length > 1) return Promise.resolve({ consumed: false, reason: 'several-windows' });
    const waiter = waiting[0];
    if (!waiter) return Promise.resolve({ consumed: false, reason: 'no-window' });
    // Bind receipt to the original window before yielding. Replacing that
    // purchase/window in the next microtask cannot adopt an earlier reply.
    // Count admission now too: a reentrant expiry cannot call this silence.
    waiter.readings++;
    // Track admission before the judgment port can synchronously request close.
    const work = Promise.resolve().then(() => this.readOffer(waiter, channel, text, receivedAtMs, context));
    this.#offers.add(work);
    void work.then(() => this.#offers.delete(work), () => this.#offers.delete(work));
    return work;
  }

  private async readOffer(waiter: Waiter, channel: CommandAuthorityChannel, text: string, receivedAtMs: number | undefined, context?: PaymentReplyCorrelation): Promise<PaymentReplyOffer> {
    let recorded = false;
    try {
      this.expireWindows();
      if (!this.current(waiter)) return { consumed: false, reason: 'no-window' };
      if (waiter.deadlineMs === undefined) await waiter.receptionReady;
      if (!this.current(waiter) || !waiter.armedChannels?.includes(channel)) return { consumed: false, reason: 'no-window' };
      const receipt = waiter.receipts.get(channel);
      if (receipt && context && !matchesReceipt(receipt, context)) return { consumed: false, reason: 'no-window' };
      if (context?.verifyAccount) {
        const account = await context.verifyAccount();
        if (!this.current(waiter)) return { consumed: false, reason: 'no-window' };
        context = Object.freeze({ ...context, accountId: account.accountId, assertCurrent: account.assertCurrent });
      }
      if ((waiter.requireDeliveryReceipt || receipt) && (!context || !receipt || !receipt.accountId || !context.accountId || !context.assertCurrent)) {
        waiter.cancel(new PaymentReplyWindowError('source-unavailable')); return { consumed: false, reason: 'no-window' };
      }
      if (receipt && context && !matchesReceipt(receipt, context)) return { consumed: false, reason: 'no-window' };
      context?.assertCurrent?.();
      if (channel === 'telegram' && context) {
        if (receivedAtMs === undefined) throw new PaymentReplyWindowError('clock-unavailable');
        recorded = await this.#history.record(text, context, receivedAtMs);
        context.assertCurrent?.(); if (!this.current(waiter)) return { consumed: false, reason: recorded ? 'recorded' : 'no-window' };
      }
      if (waiter.deadlineMs === undefined) throw new PaymentReplyWindowError('invalid');
      if (receivedAtMs === undefined) throw new PaymentReplyWindowError('clock-unavailable');
      // Polling may deliver a queued, on-time provider reply while expiry is
      // awaiting receive progress. Provider dates have whole-second precision;
      // late processing can grant only when the entire timestamp bucket fits.
      const providerTime = context?.sentAtMs;
      const validProviderTime = providerTime !== undefined && Number.isSafeInteger(providerTime) && providerTime >= 0;
      const providerOnTime = waiter.requireDeliveryReceipt && validProviderTime && providerTime + 1000 <= waiter.deadlineMs;
      if (receivedAtMs >= waiter.deadlineMs && !providerOnTime) {
        // A queued reply with missing time or a timestamp bucket overlapping
        // expiry might be an on-time objection. It cannot authorize spending
        // or be discarded as silence. A wholly later reply stays outside the
        // original window. Actual local arrival before expiry needs no date.
        if (waiter.requireDeliveryReceipt && (!validProviderTime || providerTime < waiter.deadlineMs))
          waiter.cancel(new PaymentReplyWindowError('unsettled-reply'));
        else waiter.expire();
        return { consumed: false, reason: recorded ? 'recorded' : 'no-window' };
      }
      const answer = await readPaymentReply(text, waiter.kind, waiter.notice, waiter.abort.signal, context?.assertCurrent?.bind(context));
      context?.assertCurrent?.();
      // A late result cannot revive this window, nor a later wait reusing its ID.
      if (!this.current(waiter)) return { consumed: false, reason: recorded ? 'recorded' : 'no-window' };
      const answeredAt = this.currentTime();
      if (answeredAt === undefined) { waiter.cancel(new PaymentReplyWindowError('clock-unavailable')); return { consumed: false, reason: 'no-window' }; }
      if (answeredAt >= waiter.deadlineMs) {
        waiter.expire();
        if (!this.current(waiter) || waiter.coverage === undefined) return { consumed: false, reason: recorded ? 'recorded' : 'no-window' };
      }
      if (answer === null) return { consumed: false, reason: 'not-an-answer' };
      waiter.settle({ answer, channel });
      return { consumed: true, answer };
    } catch (error) {
      if (!this.current(waiter) && (error === waiter.abort.signal.reason || (error instanceof JudgmentError && error.kind === 'aborted')))
        return { consumed: false, reason: recorded ? 'recorded' : 'no-window' };
      // A reply arrived but could not be interpreted. Allowing the veto timer
      // to call this silence would spend while the decision layer is unavailable.
      if (this.current(waiter)) waiter.cancel(error instanceof PaymentReplyWindowError && error.kind === 'source-unavailable'
        || error instanceof JudgmentError || error instanceof JudgmentPortMissingError || error instanceof DecisionModelsDisabledError
        ? error : new PaymentReplyWindowError(error instanceof PaymentReplyHistoryError ? 'history-unavailable' : 'reading-failed'));
      throw error;
    } finally { waiter.readings--; }
  }

  private current(waiter: Waiter): boolean { return this.#waiting.get(waiter.purchaseId) === waiter; }

  private expireWindows(): void {
    const now = this.currentTime();
    for (const waiter of [...this.#waiting.values()]) {
      if (now === undefined) waiter.cancel(new PaymentReplyWindowError('clock-unavailable'));
      else if (waiter.deadlineMs !== undefined && now >= waiter.deadlineMs) waiter.expire();
    }
  }

  private currentTime(): number | undefined {
    try { const now = this.#now(); return Number.isFinite(now) ? now : undefined; }
    catch { return undefined; }
  }
}
