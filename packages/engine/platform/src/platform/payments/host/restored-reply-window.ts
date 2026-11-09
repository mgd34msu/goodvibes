/** Restores an original native Telegram receive span, not receiving authority
 * from saved JSON. Only uncovered actual recipients get another notice. */
import { isDeepStrictEqual } from 'node:util';
import type { CheckoutWindowCheckpoint } from '../checkout-window-checkpoint.js';
import { CheckoutOwnershipError } from '../checkout-ownership.js';
import { createChannelPaymentNotifier, readPaymentReply, type PaymentNoticeTarget, type PaymentNoticeRouter, type PaymentAnswer } from '../notice-delivery.js';
import { capturePaymentReplyHistory, paymentReplyWindowReceiveCovered, type PaymentReplyHistory, type PaymentReplyHistoryEntry, type PaymentReplyHistoryWindow, type PaymentReplyReceiveSpan } from '../reply-history.js';
import { PaymentReplyWindowError, type PaymentReplyInbox } from '../reply-inbox.js';
import type { ChannelDeliveryReceipt } from '../../channels/delivery/types.js';
import type { PaymentNoticeWindow } from '../payment-ports.js';
import type { ChannelDelivery } from '../windows.js';

interface OriginalRecipient {
  readonly receipt: ChannelDeliveryReceipt;
  readonly delivery: ChannelDelivery;
  readonly target: PaymentNoticeTarget;
}
interface RestoreReplyWindowInput {
  readonly purchaseId: string;
  readonly checkpoint: CheckoutWindowCheckpoint;
  readonly recipients: readonly OriginalRecipient[];
  readonly readHistory: (() => Promise<PaymentReplyHistory | undefined>) | undefined;
  readonly replies: PaymentReplyInbox;
  readonly router: PaymentNoticeRouter;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  readonly renewMinutes: number;
}
const sameReceipt = (left: ChannelDeliveryReceipt, right: ChannelDeliveryReceipt): boolean => isDeepStrictEqual(left, right);
const matchesEntry = (receipt: ChannelDeliveryReceipt, entry: PaymentReplyHistoryEntry): boolean => receipt.accountId === entry.accountId
  && receipt.conversationId === entry.conversationId && (receipt.threadId ?? null) === entry.threadId
  && (entry.replyToMessageId === null || entry.replyToMessageId === receipt.messageId) && Number(entry.messageId) > Number(receipt.messageId);
const originalSpan = (window: PaymentReplyHistoryWindow, receipt: ChannelDeliveryReceipt): PaymentReplyReceiveSpan | undefined =>
  window.receiveSpans?.find(span => sameReceipt(span.receipt, receipt));
const cutoff = (window: PaymentReplyHistoryWindow, receipt: ChannelDeliveryReceipt): number => originalSpan(window, receipt)?.deadlineMs ?? window.binding.deadlineMs;
const alreadyCovered = (window: PaymentReplyHistoryWindow, receipt: ChannelDeliveryReceipt): boolean => window.receiveCoverage?.some(
  entry => sameReceipt(entry.receipt, receipt) && entry.throughMs === cutoff(window, receipt)) ?? false;

export function prepareRestoredPaymentReplyWindow(input: RestoreReplyWindowInput) {
  const { purchaseId, checkpoint, recipients, replies, router } = input;
  const retiredOwner = new AbortController(), signal = AbortSignal.any([input.signal, retiredOwner.signal]);
  const kind = checkpoint.record.windowKind, notice = checkpoint.record.windowNotice;
  if (!kind || notice === undefined || !recipients.length) throw new CheckoutOwnershipError();
  let reception: PaymentNoticeWindow | undefined, retired = false, historicalAnswer: PaymentAnswer | null | undefined;
  let resumedDeadline = checkpoint.record.windowDeadlineMs ?? Number.NaN;
  const current = () => { signal.throwIfAborted(); input.assertCurrent(); if (retired) throw new CheckoutOwnershipError(); };
  const now = () => {
    current(); const value = Date.now();
    if (!Number.isSafeInteger(value) || value < checkpoint.record.updatedAtMs) throw new PaymentReplyWindowError('clock-unavailable');
    return value;
  };
  const ready = (async (): Promise<readonly ChannelDelivery[]> => {
    const accounts = await Promise.allSettled(recipients.map(({ receipt }) => replies.retainTelegramReceipt(receipt, { signal, assertCurrent: current })));
    const guards: (() => void)[] = [];
    for (const account of accounts) {
      if (account.status === 'rejected') throw new PaymentReplyWindowError('source-unavailable');
      guards.push(account.value.assertCurrent.bind(account.value));
    }
    const sourceCurrent = () => { current(); for (const guard of guards) guard(); };
    const history = async (): Promise<PaymentReplyHistoryWindow | undefined> => {
      sourceCurrent(); let retained: PaymentReplyHistory | undefined;
      try { retained = await input.readHistory?.(); sourceCurrent(); }
      catch { sourceCurrent(); throw new PaymentReplyWindowError('history-unavailable'); }
      if (!retained) return undefined;
      let captured: PaymentReplyHistory;
      try { captured = capturePaymentReplyHistory(retained, checkpoint); }
      catch { throw new PaymentReplyWindowError('history-unavailable'); }
      const window = captured.windows.at(-1), time = now();
      if (!window || time < window.startedAtMs || window.receiveCoverage?.some(entry => entry.checkedAtMs > time)) throw new PaymentReplyWindowError('clock-unavailable');
      return window;
    };
    let original = await history(); sourceCurrent();
    const interpreted = new Map<string, PaymentAnswer | null>();
    const uncertainReceipts = new Set<ChannelDeliveryReceipt>();
    const readAnswers = async (window: PaymentReplyHistoryWindow | undefined, positiveAllowed: boolean): Promise<PaymentAnswer | undefined> => {
      if (!window) return undefined;
      let positive: PaymentAnswer | undefined;
      for (const entry of [...window.entries].sort((a, b) => Number(a.updateId) - Number(b.updateId))) {
        const matching = recipients.filter(({ receipt }) => matchesEntry(receipt, entry));
        const onTime = matching.filter(({ receipt }) => entry.receivedAtMs < cutoff(window, receipt) || entry.sentAtMs + 1000 <= cutoff(window, receipt));
        for (const { receipt } of matching) if (entry.receivedAtMs >= cutoff(window, receipt)
          && entry.sentAtMs < cutoff(window, receipt) && entry.sentAtMs + 1000 > cutoff(window, receipt)) uncertainReceipts.add(receipt);
        if (!onTime.length) continue;
        const id = JSON.stringify([entry.accountId, entry.updateId]);
        let answer = interpreted.get(id);
        if (!interpreted.has(id)) {
          answer = await readPaymentReply(entry.text, kind, notice, signal, sourceCurrent); sourceCurrent();
          interpreted.set(id, answer ?? null);
        }
        // A correctly addressed original objection stops the purchase without
        // needing proof that no other reply was lost during downtime.
        if (answer === 'deny' || answer === 'object') return answer;
        if (positiveAllowed && onTime.length === 1 && (answer === 'approve' || answer === 'acknowledge')) {
          const recipient = onTime[0];
          if (recipient && !alreadyCovered(window, recipient.receipt) && originalSpan(window, recipient.receipt)?.acceptPositive !== false) positive ??= answer;
        }
      }
      return positive;
    };
    const objection = await readAnswers(original, false); sourceCurrent();
    if (objection) { historicalAnswer = objection; return checkpoint.record.windowDeliveries ?? []; }
    if (original && paymentReplyWindowReceiveCovered(original)) {
      if (now() < original.binding.deadlineMs) throw new PaymentReplyWindowError('clock-unavailable');
      historicalAnswer = null; return checkpoint.record.windowDeliveries ?? [];
    }
    const covered = new Map<ChannelDeliveryReceipt, () => void>();
    // Every wait uses the real saved polling cursor and same original archive.
    // A missing span, gap, retention loss or exhausted drain is uncovered.
    const recovering = await Promise.allSettled(recipients.map(async ({ receipt }) => {
      if (!original) return;
      if (alreadyCovered(original, receipt)) { covered.set(receipt, sourceCurrent); return; }
      const span = originalSpan(original, receipt); if (!span) return;
      try {
        const claim = await replies.retainTelegramReceiveSpan(receipt, span.selector, Math.min(span.deadlineMs, now()), { signal, assertCurrent: sourceCurrent });
        sourceCurrent(); claim.assertCurrent(); covered.set(receipt, claim.assertCurrent.bind(claim));
      } catch { sourceCurrent(); }
    }));
    for (const claim of recovering) if (claim.status === 'rejected') throw claim.reason;
    original = await history(); sourceCurrent();
    const allCovered = () => {
      sourceCurrent(); let complete = true;
      for (const { receipt } of recipients) {
        const check = covered.get(receipt);
        if (!check || uncertainReceipts.has(receipt)) { complete = false; continue; }
        try { check(); } catch { sourceCurrent(); covered.delete(receipt); complete = false; }
      }
      return complete;
    };
    const answer = await readAnswers(original, allCovered()); sourceCurrent();
    if (answer) { if (answer === 'approve' || answer === 'acknowledge') { if (!allCovered()) throw new PaymentReplyWindowError('receive-uncovered'); }
      historicalAnswer = answer; return checkpoint.record.windowDeliveries ?? []; }
    // Certify only expired recipients, at their actual original cutoff. The
    // marker does not widen when a different recipient needs a new notice.
    if (original) for (const { receipt } of recipients) {
      const check = covered.get(receipt), through = cutoff(original, receipt);
      if (!check || uncertainReceipts.has(receipt) || through > now() || alreadyCovered(original, receipt)) continue;
      try { check(); } catch { sourceCurrent(); covered.delete(receipt); continue; }
      await replies.recordRestoredReceiveCoverage(purchaseId, receipt, through, () => { sourceCurrent(); check(); }); sourceCurrent();
    }
    const settledWindow = original;
    if (settledWindow && allCovered() && recipients.every(({ receipt }) => cutoff(settledWindow, receipt) <= now())) {
      historicalAnswer = null; return checkpoint.record.windowDeliveries ?? [];
    }
    allCovered();
    const remaining = recipients.filter(({ receipt }) => !covered.has(receipt) || uncertainReceipts.has(receipt));
    const retained: PaymentReplyReceiveSpan[] = [];
    if (original) for (const { receipt } of recipients) {
      const span = originalSpan(original, receipt);
      if (span && covered.has(receipt) && !uncertainReceipts.has(receipt) && span.deadlineMs > now())
        retained.push(Object.freeze({ ...span, acceptPositive: span.acceptPositive && remaining.length === 0 }));
    }
    const prepared = replies.prepareRecoveredAnswer({ purchaseId, kind, channels: ['telegram'], notice, signal, requireDeliveryReceipt: true }, retained, remaining.length > 0);
    reception = { deliveries: Promise.resolve([]), cancel: prepared.cancel,
      awaitAnswer(deadlineMs) { sourceCurrent(); return prepared.waitForAnswer({ deadlineMs, channels: ['telegram'], deliveries: report }); } };
    // Reserve before yielding again: any new update now belongs to this same
    // waiter, while original archived objections are checked before re-sending.
    original = await history(); sourceCurrent();
    const lastAnswer = await readAnswers(original, remaining.length === 0 && allCovered()); sourceCurrent();
    if (lastAnswer) {
      if ((lastAnswer === 'approve' || lastAnswer === 'acknowledge') && !allCovered()) throw new PaymentReplyWindowError('receive-uncovered');
      prepared.cancel(); historicalAnswer = lastAnswer; return checkpoint.record.windowDeliveries ?? []; }
    const notifier = createChannelPaymentNotifier({ requireDeliveryReceipt: true, router, targets: remaining.map(entry => entry.target), replies });
    const sent = remaining.length ? await notifier.deliver({ kind, message: notice, signal, assertCurrent: sourceCurrent }) : [];
    sourceCurrent();
    if (sent.length !== remaining.length || sent.some((delivery, index) => {
      const expected = remaining[index]?.receipt, actual = delivery.receipt;
      return !delivery.delivered || !expected || !actual || actual.accountId !== expected.accountId
        || actual.conversationId !== expected.conversationId || actual.threadId !== expected.threadId
        || !/^[1-9]\d{0,15}$/.test(actual.messageId) || !Number.isSafeInteger(Number(actual.messageId)) || Number(actual.messageId) <= Number(expected.messageId);
    })) throw new PaymentReplyWindowError('source-unavailable');
    const report: readonly ChannelDelivery[] = Object.freeze([...recipients.filter(({ receipt }) => retained.some(span => sameReceipt(span.receipt, receipt))).map(entry => entry.delivery), ...sent]);
    if (!report.length) throw new PaymentReplyWindowError('receive-uncovered');
    resumedDeadline = remaining.length ? Math.max(...retained.map(span => span.deadlineMs), now() + input.renewMinutes * 60_000) : checkpoint.record.windowDeadlineMs ?? Number.NaN;
    reception = Object.freeze({ ...reception, deliveries: Promise.resolve(report) });
    return report;
  })();
  const deliveries = ready.catch(error => { retiredOwner.abort(); reception?.cancel(); throw error; }); void deliveries.catch(() => {});
  const deadlineMs = deliveries.then(() => { current(); return resumedDeadline; }); void deadlineMs.catch(() => {});
  return Object.freeze({ deliveries, deadlineMs, cancel() { retired = true; retiredOwner.abort(); reception?.cancel(); },
    awaitAnswer(deadline: number) {
      current();
      if (historicalAnswer !== undefined) return Promise.resolve(historicalAnswer === null ? null : { answer: historicalAnswer, channel: 'telegram' as const });
      if (!reception) throw new CheckoutOwnershipError(); return reception.awaitAnswer(deadline);
    } });
}
