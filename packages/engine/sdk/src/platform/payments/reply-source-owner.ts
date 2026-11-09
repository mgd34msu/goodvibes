import type { ChannelDeliveryReceipt } from '../channels/delivery/types.js';
import type { TelegramSourceAccountReader } from '../channels/telegram/source-account.js';
import { OwnedWork } from '../utils/owned-work.js';
import { capturePaymentNoticeReceipt } from './notice-receipt.js';

export interface PaymentReplySourceGuard {
  readonly ready: Promise<void>;
  assertReceiptCurrent(receipt: ChannelDeliveryReceipt | undefined): void;
  waitForCoverage(receipt: ChannelDeliveryReceipt | undefined, throughMs: number): Promise<() => void>;
}
interface Binding {
  readonly reader: TelegramSourceAccountReader;
  readonly lifetime: AbortSignal;
  readonly abort: AbortController;
}

/** Retains the actual ingress account selected before a notice is sent. A
 * provider ID in a receipt cannot replace this session's private handle.
 * This establishes live source custody, not durable missed-message coverage. */
export class PaymentReplySourceOwner {
  private binding: Binding | undefined;
  private closed = false;
  private readonly work = new OwnedWork();

  bindTelegram(reader: TelegramSourceAccountReader | undefined, lifetime: AbortSignal): void {
    if (this.closed) throw new Error('Payment reply source is unavailable');
    this.binding?.abort.abort();
    // Capture methods now; neither an embed wrapper nor a replacement facade
    // can change which account a previously admitted notice retained.
    this.binding = reader === undefined ? undefined : Object.freeze({ lifetime, abort: new AbortController(), reader: Object.freeze({
      acquire: reader.acquire.bind(reader), read: reader.read.bind(reader), assertCurrent: reader.assertCurrent.bind(reader),
      current: reader.current.bind(reader), subscribeIdentityChange: reader.subscribeIdentityChange.bind(reader),
      ...(reader.acquireWhenAvailable ? { acquireWhenAvailable: reader.acquireWhenAvailable.bind(reader) } : {}),
      ...(reader.retainReceiveCoverage ? { retainReceiveCoverage: reader.retainReceiveCoverage.bind(reader) } : {}),
    }) });
  }

  reserveTelegram(signal: AbortSignal, sinceMs = Date.now()): PaymentReplySourceGuard {
    const binding = this.binding;
    const lifetime = binding ? AbortSignal.any([signal, binding.lifetime, binding.abort.signal]) : signal;
    let coverage: ReturnType<NonNullable<TelegramSourceAccountReader['retainReceiveCoverage']>> = null;
    try { coverage = binding?.reader.retainReceiveCoverage?.() ?? null; } catch { /* Operator answers remain available; silence requires actual coverage. */ }
    const retainedCoverage = coverage;
    let observed: { readonly id: string; readonly revision: string; readonly assertCurrent: () => void;
      readonly waitForCoverage: (throughMs: number, receipt: ChannelDeliveryReceipt) => Promise<() => void> } | undefined;
    const current = () => {
      if (this.closed || !binding || binding !== this.binding || lifetime.aborted) {
        throw new Error('Payment reply source is unavailable');
      }
    };
    // Admit ownership before calling any injected reader, including one that
    // reenters shutdown. Retirement drains the original read, even if it
    // ignores cancellation; a late result never becomes source authority.
    const ready = this.work.run(async () => {
      await Promise.resolve(); current();
      if (!binding) throw new Error('Payment reply source is unavailable');
      const handle = await (binding.reader.acquireWhenAvailable
        ? binding.reader.acquireWhenAvailable(lifetime) : binding.reader.acquire()); current();
      if (!handle) throw new Error('Payment reply source is unavailable');
      const account = await binding.reader.read(handle); current();
      if (!account) throw new Error('Payment reply source is unavailable');
      const id = account.id, revision = account.revision;
      const assertCurrent = () => {
        current();
        const live = binding.reader.assertCurrent(handle);
        if (live.id !== id || live.revision !== revision) throw new Error('Payment reply source is unavailable');
      };
      assertCurrent(); observed = Object.freeze({ id, revision, assertCurrent,
        waitForCoverage: async (throughMs: number, receipt: ChannelDeliveryReceipt) => {
          assertCurrent(); if (!retainedCoverage) throw new Error('Payment receive coverage is unavailable');
          const covered = await retainedCoverage.waitFor(handle, sinceMs, throughMs, lifetime, { conversationId: receipt.conversationId, threadId: receipt.threadId });
          assertCurrent(); covered(); return () => { assertCurrent(); covered(); };
        } });
    });
    void ready.catch(() => { /* An unavailable source leaves operator answers usable; expiry refuses silence. */ });
    const assertReceiptCurrent = (receipt: ChannelDeliveryReceipt | undefined) => {
      current();
      if (!observed || receipt?.surfaceKind !== 'telegram' || receipt.accountId !== observed.id) throw new Error('Payment reply source is unavailable');
      observed.assertCurrent();
    };
    return Object.freeze({ ready, assertReceiptCurrent, waitForCoverage: (receipt: ChannelDeliveryReceipt | undefined, throughMs: number) => this.work.run(async () => {
      const original = capturePaymentNoticeReceipt(receipt, 'telegram');
      assertReceiptCurrent(original ?? undefined);
      if (!observed || !original) throw new Error('Payment receive coverage is unavailable');
      const covered = await observed.waitForCoverage(throughMs, original); assertReceiptCurrent(original);
      return () => { assertReceiptCurrent(original); covered(); };
    }) });
  }

  close(): Promise<void> {
    this.closed = true; this.binding?.abort.abort(); this.binding = undefined;
    return this.work.join();
  }
}
