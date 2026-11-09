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
import { PaymentReplyHistoryError, paymentReplyHistoryBinding, type PaymentReplyHistoryEntry, type PaymentReplyReceiveCoverage, type PaymentReplyReceiveSpan } from './reply-history.js';
import type { ChannelDelivery } from './windows.js';
import type { PaymentWindowView, PaymentWindowAnswer } from './window-view.js';
import type { TelegramSourceAccountReader } from '../channels/telegram/source-account.js';
import { PaymentReplySourceOwner, type PaymentReplySourceGuard } from './reply-source-owner.js';
import type { PaymentOperationView } from './operation-view.js';
import type { TelegramPaymentReceiveSelector } from '../channels/telegram/payment-receive-span.js';
export type { PaymentWindowView, PaymentWindowAnswer } from './window-view.js';

interface Waiter {
  readonly requireDeliveryReceipt: boolean;
  receipts: ReadonlyMap<CommandAuthorityChannel, readonly ChannelDeliveryReceipt[]>;
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
  receiptSources: readonly { readonly window: PaymentReplyReceiveSpan; readonly source: PaymentReplySourceGuard }[];
  coverage?: Promise<() => void>;
  expire(): void;
  settle(answer: { readonly answer: PaymentAnswer; readonly channel: PaymentAnswerChannel } | null): void;
  cancel(error: Error): void;
}
const receiptKey = (receipt: ChannelDeliveryReceipt) => JSON.stringify([receipt.surfaceKind, receipt.accountId,
  receipt.conversationId, receipt.threadId ?? null, receipt.messageId]);
const originalReceiptWindow = (waiter: Waiter, receipt: ChannelDeliveryReceipt | undefined) => receipt === undefined ? undefined
  : waiter.receiptSources.find(entry => receiptKey(entry.window.receipt) === receiptKey(receipt));
const receiptSource = (waiter: Waiter, receipt: ChannelDeliveryReceipt | undefined) => originalReceiptWindow(waiter, receipt)?.source ?? waiter.source;
const receiptDeadline = (waiter: Waiter, receipt: ChannelDeliveryReceipt | undefined) => originalReceiptWindow(waiter, receipt)?.window.deadlineMs ?? waiter.deadlineMs;

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
  #operationReader: { readonly read: (purchaseId: string) => PaymentOperationView | null; readonly current: () => void } | undefined;

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  /** Composition-only binding to the same ingress owner used for channel
   * replies. Rebinding retires prior preparations; it does no provider I/O. */
  bindTelegramSource(reader: TelegramSourceAccountReader | undefined, lifetime: AbortSignal): void {
    this.#sources.bindTelegram(reader, lifetime);
  }

  /** Native composition only: terminal source cleanup uses actual durable
   * operation status, never an abort or a provider identity supplied as JSON. */
  bindDurableOperationReader(read: (purchaseId: string) => PaymentOperationView | null, current: () => void): void {
    this.#operationReader = Object.freeze({ read, current });
  }
  mayRetireReceiveSpan(purchaseId: string): boolean {
    const owner = this.#operationReader;
    if (!owner || this.#closed) return false;
    try {
      owner.current(); const status = owner.read(purchaseId); owner.current();
      return status !== null && (status.state === 'completed' || status.state === 'refused' || status.state === 'cancelled' || status.state === 'failed');
    } catch { return false; }
  }

  /** Save the selector actually reserved before sending this notice. A
   * missing native polling span is preserved as uncovered, never synthesized. */
  async captureReceiveSpans(purchaseId: string, checkpoint: CheckoutWindowCheckpoint, assertCurrent: () => void): Promise<readonly PaymentReplyReceiveSpan[]> {
    const waiter = this.#waiting.get(purchaseId), source = waiter?.source;
    assertCurrent(); if (!waiter) return [];
    const current = () => {
      assertCurrent();
      if (!waiter || !this.current(waiter) || waiter.source !== source || waiter.kind !== checkpoint.record.windowKind
        || waiter.notice !== checkpoint.record.windowNotice) throw new PaymentReplyHistoryError();
    };
    current(); if (!source) return [];
    try { await source.ready; } catch { current(); return []; }
    current();
    const result: PaymentReplyReceiveSpan[] = [];
    for (const receipt of paymentReplyHistoryBinding(checkpoint).receipts) {
      const selected = receiptSource(waiter, receipt);
      if (!selected) continue;
      await selected.ready; current();
      const selector = selected.coverageSelector(receipt); current();
      const original = originalReceiptWindow(waiter, receipt)?.window;
      if (selector) result.push(Object.freeze({ receipt, selector, deadlineMs: original?.deadlineMs ?? checkpoint.record.windowDeadlineMs ?? Number.NaN,
        acceptPositive: original?.acceptPositive ?? true }));
    }
    return Object.freeze(result);
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

  async retainTelegramReceiveSpan(receipt: ChannelDeliveryReceipt, selector: TelegramPaymentReceiveSelector, throughMs: number,
    owner: { readonly signal: AbortSignal; readonly assertCurrent: () => void }): Promise<{ assertCurrent(): void }> {
    owner.signal.throwIfAborted(); owner.assertCurrent();
    const source = this.#sources.reserveTelegram(owner.signal, selector.sinceMs, selector.purchaseId, selector);
    await source.ready; owner.assertCurrent(); source.assertReceiptCurrent(receipt);
    const covered = await source.waitForCoverage(receipt, throughMs); owner.assertCurrent();
    return Object.freeze({ assertCurrent() { owner.signal.throwIfAborted(); owner.assertCurrent(); source.assertReceiptCurrent(receipt); covered(); } });
  }
  async recordRestoredReceiveCoverage(purchaseId: string, receipt: ChannelDeliveryReceipt, throughMs: number, assertCurrent: () => void): Promise<void> {
    assertCurrent();
    if (!await this.#history.recordReceiveCoverage(purchaseId, { resolution: 'silence', receipt, throughMs, checkedAtMs: this.#now() }, assertCurrent)) throw new PaymentReplyHistoryError();
    assertCurrent();
  }

  prepareRecoveredAnswer(input: Omit<Parameters<PaymentReplySource['waitForAnswer']>[0], 'deadlineMs'>,
    originals: readonly PaymentReplyReceiveSpan[], reserveFresh: boolean): PreparedPaymentReply {
    return this.prepareAnswer(input, { originals, reserveFresh });
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
  prepareAnswer(input: Omit<Parameters<PaymentReplySource['waitForAnswer']>[0], 'deadlineMs'>,
    recovery?: { readonly originals: readonly PaymentReplyReceiveSpan[]; readonly reserveFresh: boolean }): PreparedPaymentReply {
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
      receiptSources: [],
      expire: () => {
        if (!this.current(waiter)) return;
        const deadlineMs = waiter.deadlineMs;
        if (deadlineMs === undefined) return;
        const now = this.currentTime();
        if (now === undefined) { waiter.cancel(new PaymentReplyWindowError('clock-unavailable')); return; }
        if (now < deadlineMs) { armTimer(); return; }
        if (waiter.requireDeliveryReceipt && waiter.armedChannels?.some(channel => {
          const receipts = waiter.receipts.get(channel); return !receipts?.length || receipts.some(receipt => !receipt.accountId);
        })) { waiter.cancel(new PaymentReplyWindowError('source-unavailable')); return; }
        if (waiter.requireDeliveryReceipt && waiter.armedChannels?.includes('telegram')) {
          const source = waiter.source;
          try {
            if (!source) throw new Error();
            for (const receipt of waiter.receipts.get('telegram') ?? []) {
              const selected = receiptSource(waiter, receipt); if (!selected) throw new Error(); selected.assertReceiptCurrent(receipt);
            }
          } catch { waiter.cancel(new PaymentReplyWindowError('source-unavailable')); return; }
          if (!source) { waiter.cancel(new PaymentReplyWindowError('source-unavailable')); return; }
          if (!waiter.coverage) {
            const receipts = waiter.receipts.get('telegram') ?? [];
            waiter.coverage = Promise.all(receipts.map(async receipt => {
              const selected = receiptSource(waiter, receipt), through = receiptDeadline(waiter, receipt);
              if (!selected || through === undefined) throw new PaymentReplyWindowError('source-unavailable');
              return await selected.waitForCoverage(receipt, through);
            }))
              .then(assertions => () => { for (const assertion of assertions) assertion(); });
            void waiter.coverage.then(async covered => {
              if (!this.current(waiter)) return;
              const now = this.currentTime();
              if (now === undefined || now < deadlineMs) { waiter.cancel(new PaymentReplyWindowError('clock-unavailable')); return; }
              if (waiter.readings > 0) { waiter.cancel(new PaymentReplyWindowError('unsettled-reply')); return; }
              const current = () => {
                if (!this.current(waiter) || waiter.source !== source) throw new Error();
                for (const receipt of receipts) {
                  const selected = receiptSource(waiter, receipt); if (!selected) throw new Error(); selected.assertReceiptCurrent(receipt);
                } covered();
                if (waiter.readings > 0) throw new PaymentReplyWindowError('unsettled-reply');
              };
              try { current(); }
              catch { waiter.cancel(new PaymentReplyWindowError('source-unavailable')); return; }
              try {
                if (!receipts.length) throw new PaymentReplyWindowError('source-unavailable');
                for (const receipt of receipts) {
                  await this.#history.recordReceiveCoverage(waiter.purchaseId, { resolution: 'silence', receipt, throughMs: receiptDeadline(waiter, receipt) ?? deadlineMs, checkedAtMs: now }, current);
                  current();
                }
                current(); waiter.settle(null);
              } catch (error) {
                if (this.current(waiter)) waiter.cancel(new PaymentReplyWindowError(error instanceof PaymentReplyHistoryError ? 'coverage-unrecorded' : 'source-unavailable'));
              }
            }, () => {
              if (!this.current(waiter)) return;
              try { if (waiter.source !== source) throw new Error(); for (const receipt of receipts) receiptSource(waiter, receipt)?.assertReceiptCurrent(receipt); }
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
    try {
      if (requireDeliveryReceipt && channels.includes('telegram') && this.current(waiter)) {
        if (recovery) {
          waiter.receiptSources = Object.freeze(recovery.originals.map(value => {
            const receipt = capturePaymentNoticeReceipt(value.receipt, 'telegram');
            if (!receipt || value.selector.purchaseId !== purchaseId || value.selector.accountId !== receipt.accountId) throw new PaymentReplyWindowError('invalid');
            const window = Object.freeze({ ...value, receipt });
            return Object.freeze({ window, source: this.#sources.reserveTelegram(waiter.abort.signal, value.selector.sinceMs, purchaseId, value.selector) });
          }));
        }
        waiter.source = !recovery || recovery.reserveFresh
          ? this.#sources.reserveTelegram(waiter.abort.signal, this.currentTime() ?? Number.NaN, purchaseId)
          : waiter.receiptSources[0]?.source;
      }
    } catch (error) { waiter.cancel(new PaymentReplyWindowError('source-unavailable')); throw error; }
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
        const receipts = new Map<CommandAuthorityChannel, readonly ChannelDeliveryReceipt[]>();
        try {
          if (armed.deliveries !== undefined && (!Array.isArray(armed.deliveries) || armed.deliveries.length > 256)) throw new PaymentReplyWindowError('invalid');
          for (const delivery of armed.deliveries ?? []) {
            if (!delivery.delivered || !deliveredChannels.includes(delivery.channel)) continue;
            const receipt = capturePaymentNoticeReceipt(delivery.receipt, delivery.channel);
            if (receipt) receipts.set(delivery.channel, Object.freeze([...(receipts.get(delivery.channel) ?? []), receipt]));
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
      const receipts = waiter.receipts.get(channel);
      return !context || !receipts?.length || receipts.some(receipt => matchesReceipt(receipt, context));
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
    if (waiting.length > 1) {
      if (waiting.every(waiter => waiter.deadlineMs !== undefined)) return Promise.resolve({ consumed: false, reason: 'several-windows' });
      // Receipt IDs are not known until the guarded sends finish. Retain this
      // actual update until those same original reservations arm or retire;
      // confirming it now would lose an addressed early reply on restart.
      for (const waiter of waiting) waiter.readings++;
      const pending = Promise.resolve().then(async (): Promise<PaymentReplyOffer> => {
        try {
          await Promise.all(waiting.map(waiter => waiter.receptionReady));
          if (this.#closed) return { consumed: false, reason: 'no-window' };
          const matching = waiting.filter(waiter => this.current(waiter) && (waiter.armedChannels ?? []).includes(channel)
            && (!context || (waiter.receipts.get(channel) ?? []).some(receipt => matchesReceipt(receipt, context))));
          if (matching.length !== 1) return { consumed: false, reason: matching.length ? 'several-windows' : 'no-window' };
          const waiter = matching[0]; if (!waiter) return { consumed: false, reason: 'no-window' };
          waiter.readings++; return await this.readOffer(waiter, channel, text, receivedAtMs, context);
        } finally { for (const waiter of waiting) waiter.readings--; }
      });
      this.#offers.add(pending); void pending.then(() => this.#offers.delete(pending), () => this.#offers.delete(pending)); return pending;
    }
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
      const receipts = waiter.receipts.get(channel) ?? [];
      let receipt = context ? receipts.find(candidate => matchesReceipt(candidate, context)) : receipts.length === 1 ? receipts[0] : undefined;
      if (receipts.length && context && !receipt) return { consumed: false, reason: 'no-window' };
      if (context?.verifyAccount) {
        const account = await context.verifyAccount();
        if (!this.current(waiter)) return { consumed: false, reason: 'no-window' };
        const verified = Object.freeze({ ...context, accountId: account.accountId, assertCurrent: account.assertCurrent });
        context = verified; receipt = receipts.find(candidate => matchesReceipt(candidate, verified));
      }
      if ((waiter.requireDeliveryReceipt || receipt) && (!context || !receipt || !receipt.accountId || !context.accountId || !context.assertCurrent)) {
        waiter.cancel(new PaymentReplyWindowError('source-unavailable')); return { consumed: false, reason: 'no-window' };
      }
      if (context) {
        const retainedContext = context, matching = receipts.filter(candidate => matchesReceipt(candidate, retainedContext));
        if (new Set(matching.map(candidate => receiptDeadline(waiter, candidate))).size > 1) throw new PaymentReplyWindowError('unsettled-reply');
      }
      if (receipt && context && !matchesReceipt(receipt, context)) return { consumed: false, reason: 'no-window' };
      context?.assertCurrent?.();
      if (channel === 'telegram' && context) {
        if (receivedAtMs === undefined) throw new PaymentReplyWindowError('clock-unavailable');
        recorded = await this.#history.record(text, context, receivedAtMs);
        context.assertCurrent?.(); if (!this.current(waiter)) return { consumed: false, reason: recorded ? 'recorded' : 'no-window' };
      }
      if (waiter.deadlineMs === undefined) throw new PaymentReplyWindowError('invalid');
      const selectedDeadline = receiptDeadline(waiter, receipt) ?? waiter.deadlineMs;
      if (receivedAtMs === undefined) throw new PaymentReplyWindowError('clock-unavailable');
      // Polling may deliver a queued, on-time provider reply while expiry is
      // awaiting receive progress. Provider dates have whole-second precision;
      // late processing can grant only when the entire timestamp bucket fits.
      const providerTime = context?.sentAtMs;
      const validProviderTime = providerTime !== undefined && Number.isSafeInteger(providerTime) && providerTime >= 0;
      const providerOnTime = waiter.requireDeliveryReceipt && validProviderTime && providerTime + 1000 <= selectedDeadline;
      if (receivedAtMs >= selectedDeadline && !providerOnTime) {
        // A queued reply with missing time or a timestamp bucket overlapping
        // expiry might be an on-time objection. It cannot authorize spending
        // or be discarded as silence. A wholly later reply stays outside the
        // original window. Actual local arrival before expiry needs no date.
        if (waiter.requireDeliveryReceipt && (!validProviderTime || providerTime < selectedDeadline))
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
      if ((answer === 'approve' || answer === 'acknowledge') && originalReceiptWindow(waiter, receipt)?.window.acceptPositive === false)
        return { consumed: false, reason: 'not-an-answer' };
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
