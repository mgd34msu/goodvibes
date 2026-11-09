/** Owns only original operation-bound archive writers. An ingress caller has
 * already checked the owner's current allowlist; provider account authority is
 * independently acquired before retaining text. No semantic reading happens. */
import { OwnedWork } from '../utils/owned-work.js';
import { captureCheckoutOwnership } from './checkout-ownership.js';
import type { CheckoutWindowCheckpoint } from './checkout-window-checkpoint.js';
import type { PaymentReplyCorrelation } from './reply-inbox.js';
import { matchesPaymentNoticeReceipt } from './notice-receipt.js';
import { PaymentReplyHistoryError, capturePaymentReplyHistoryEntry, capturePaymentReplyReceiveCoverage, paymentReplyHistoryBinding,
  type PaymentReplyHistoryBinding, type PaymentReplyHistoryEntry, type PaymentReplyReceiveCoverage } from './reply-history.js';

export interface RetainedPaymentReplyHistory {
  readonly binding: PaymentReplyHistoryBinding;
  /** Stop new admission, then drain actual appended messages before changing
   * the encrypted window or releasing its original execution lease. */
  retire(): Promise<void>;
}
interface Watch {
  readonly binding: PaymentReplyHistoryBinding;
  readonly append: (entry: PaymentReplyHistoryEntry, assertCurrent: () => void) => Promise<void>;
  readonly current: () => void;
  readonly work: OwnedWork;
  readonly recordCoverage?: ((coverage: PaymentReplyReceiveCoverage, assertCurrent: () => void) => Promise<void>) | undefined;
}
export class PaymentReplyHistoryOwner {
  private readonly watches = new Map<string, Watch>();
  private readonly retiring = new Set<Promise<void>>();
  private closed = false;
  get pending(): number { return this.watches.size; }
  has(purchaseId: string): boolean { return this.watches.has(purchaseId); }

  retain(purchaseId: string, checkpoint: CheckoutWindowCheckpoint,
    append: Watch['append'], assertCurrent: () => void, recordCoverage?: Watch['recordCoverage']): RetainedPaymentReplyHistory {
    if (this.closed || this.watches.has(purchaseId) || checkpoint.record.purchaseId !== purchaseId) throw new PaymentReplyHistoryError();
    const binding = paymentReplyHistoryBinding(checkpoint), current = captureCheckoutOwnership({ assertCurrent }).assertCurrent;
    const watch = { binding, append, current, work: new OwnedWork(), recordCoverage };
    watch.current();
    if (this.closed || this.watches.has(purchaseId)) throw new PaymentReplyHistoryError();
    this.watches.set(purchaseId, watch); let retired: Promise<void> | undefined;
    return Object.freeze({ binding, retire: () => {
      if (retired) return retired;
      if (this.watches.get(purchaseId) === watch) this.watches.delete(purchaseId);
      const pending = watch.work.join(); retired = pending; this.retiring.add(pending);
      void pending.then(() => this.retiring.delete(pending), () => this.retiring.delete(pending));
      return pending;
    } });
  }

  recordReceiveCoverage(purchaseId: string, value: PaymentReplyReceiveCoverage, assertCurrent: () => void): Promise<boolean> {
    const watch = this.watches.get(purchaseId);
    if (this.closed) return Promise.reject(new PaymentReplyHistoryError());
    const write = watch?.recordCoverage;
    if (!watch || !write) return Promise.resolve(false);
    return watch.work.run(async () => {
      try {
        const coverage = capturePaymentReplyReceiveCoverage(value, watch.binding);
        const source = captureCheckoutOwnership({ assertCurrent }).assertCurrent;
        const current = () => { source(); watch.current(); };
        current(); await write(coverage, current); current(); return true;
      } catch { throw new PaymentReplyHistoryError(); }
    });
  }

  record(text: string, correlation: PaymentReplyCorrelation | undefined, receivedAtMs: number): Promise<boolean> {
    if (this.closed || !correlation) return Promise.resolve(false);
    const context = Object.freeze({ ...correlation });
    const candidates = [...this.watches.values()].filter(watch => watch.binding.receipts.some(receipt => matchesPaymentNoticeReceipt(receipt, context)));
    if (!candidates.length) return Promise.resolve(false);
    // Reserve all candidate owners before any account await. Ambiguity can
    // only be resolved after verifying the actual receiving bot account.
    const reservations = candidates.map(watch => {
      let release!: () => void;
      const pending = new Promise<void>(done => { release = done; });
      void watch.work.run(() => pending);
      return { release };
    });
    return (async () => {
      try {
        let verified = context;
        if (!verified.accountId && verified.verifyAccount) {
          const account = await verified.verifyAccount();
          verified = Object.freeze({ ...verified, accountId: account.accountId, assertCurrent: account.assertCurrent });
        }
        if (!verified.accountId || !verified.assertCurrent) throw new PaymentReplyHistoryError();
        const sourceCurrent = captureCheckoutOwnership({ assertCurrent: verified.assertCurrent }).assertCurrent;
        sourceCurrent();
        const matching = candidates.filter(watch => watch.binding.receipts.some(receipt => matchesPaymentNoticeReceipt(receipt, verified)));
        if (matching.length !== 1) return false;
        const watch = matching[0]; if (!watch) return false;
        const entry = capturePaymentReplyHistoryEntry({ accountId: verified.accountId, userId: verified.userId,
          conversationId: verified.conversationId, threadId: verified.threadId ?? null, messageId: verified.messageId,
          updateId: verified.updateId,
          replyToMessageId: verified.replyToMessageId ?? null, sentAtMs: verified.sentAtMs, receivedAtMs, text });
        const current = () => { sourceCurrent(); watch.current(); };
        current(); await watch.append(entry, current); current(); return true;
      } catch { throw new PaymentReplyHistoryError(); }
      finally { for (const reservation of reservations) reservation.release(); }
    })();
  }

  async close(): Promise<void> {
    this.closed = true;
    const watches = [...this.watches.values()]; this.watches.clear();
    await Promise.all([...watches.map(watch => watch.work.join()), ...this.retiring]);
  }
}
