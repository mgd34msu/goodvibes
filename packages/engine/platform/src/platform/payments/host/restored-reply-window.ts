/** Restores an original native Telegram receive span, not receiving authority
 * from saved JSON. Only uncovered actual recipients get another notice. A
 * window posted to the owner inbox reads the item's recorded answer back by its
 * key and keeps waiting on the same item: an objection there stops the purchase
 * at once, an approval counts once every Telegram recipient is covered, and the
 * store's own record proves silence up to the deadline. */
import { isDeepStrictEqual } from 'node:util';
import type { CheckoutWindowCheckpoint } from '../checkout-window-checkpoint.js';
import { CheckoutOwnershipError } from '../checkout-ownership.js';
import { createChannelPaymentNotifier, readPaymentReply, type PaymentNoticeTarget, type PaymentNoticeRouter, type PaymentReplyReading } from '../notice-delivery.js';
import { capturePaymentReplyHistory, paymentReplyWindowReceiveCovered, type PaymentReplyHistory, type PaymentReplyHistoryEntry, type PaymentReplyHistoryWindow, type PaymentReplyReceiveSpan } from '../reply-history.js';
import { PaymentReplyWindowError, type PaymentReplyInbox } from '../reply-inbox.js';
import type { ChannelDeliveryReceipt } from '../../channels/delivery/types.js';
import type { PaymentNoticeWindow } from '../payment-ports.js';
import type { ChannelDelivery } from '../windows.js';
import type { OwnerItem } from '../../control-plane/owner-inbox.js';
import { inboxAnswer, purchaseInboxItem, type PaymentOwnerInbox } from './notifier.js';

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
  /** The owner-inbox item the notice was posted as, when the window reached the inbox. */
  readonly inbox?: RestoredInboxWindow | undefined;
  /** True when the purchase stops with this window kept for the next start: its inbox item stays open to be answered meanwhile. */
  readonly keepOnStop?: (() => boolean) | undefined;
}
export interface RestoredInboxWindow {
  readonly port: PaymentOwnerInbox & {
    listNow(filter: { readonly status: 'all'; readonly kinds: readonly ['purchase']; readonly limit: number }): readonly OwnerItem[];
  };
  /** `purchase:<purchaseId>:<kind>` (purchaseInboxKey). */
  readonly key: string;
  /** The checkpoint's owner-inbox delivery, reported with the resumed window. */
  readonly delivery: ChannelDelivery;
}
type WindowAnswer = Awaited<ReturnType<PaymentNoticeWindow['awaitAnswer']>>;
const INBOX_LOOKUP_LIMIT = 200;
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
  const kind = checkpoint.record.windowKind, notice = checkpoint.record.windowNotice, inbox = input.inbox;
  if (!kind || notice === undefined || (!recipients.length && !inbox)) throw new CheckoutOwnershipError();
  let reception: PaymentNoticeWindow | undefined, retired = false, historicalAnswer: PaymentReplyReading | null | undefined;
  let historicalChannel: 'telegram' | 'owner-inbox' = 'telegram';
  let resumedDeadline = checkpoint.record.windowDeadlineMs ?? Number.NaN;
  const originalDeadline = checkpoint.record.windowDeadlineMs ?? Number.NaN;
  const current = () => { signal.throwIfAborted(); input.assertCurrent(); if (retired) throw new CheckoutOwnershipError(); };
  const now = () => {
    current(); const value = Date.now();
    if (!Number.isSafeInteger(value) || value < checkpoint.record.updatedAtMs) throw new PaymentReplyWindowError('clock-unavailable');
    return value;
  };
  /** The inbox item's answer, when one was recorded by the original deadline; a store without the item cannot prove anything. */
  const inboxReading = (): PaymentReplyReading | undefined => {
    if (!inbox) return undefined;
    let item: OwnerItem | undefined;
    try { item = inbox.port.listNow({ status: 'all', kinds: ['purchase'], limit: INBOX_LOOKUP_LIMIT }).find(entry => entry.key === inbox.key); }
    catch { throw new PaymentReplyWindowError('source-unavailable'); }
    if (!item) throw new PaymentReplyWindowError('source-unavailable');
    if (item.status !== 'answered' || item.closedAt === undefined || !(item.closedAt <= originalDeadline)) return undefined;
    return readInboxAnswer(item);
  };
  /** An answer that is neither option holds the purchase: a refusal for an approval, unclear for a veto. */
  const readInboxAnswer = (item: OwnerItem): PaymentReplyReading =>
    inboxAnswer(kind, item.answer?.option ?? item.answer?.text?.trim().toLowerCase()) ?? (kind === 'approval' ? 'deny' : 'not-understood');
  const settleFromInbox = (answer: PaymentReplyReading): void => { historicalAnswer = answer; historicalChannel = 'owner-inbox'; };
  /** A window settled from what was recorded leaves no open item behind. */
  const retireOpenInboxItem = (): void => {
    if (!inbox) return;
    try {
      const open = inbox.port.listNow({ status: 'all', kinds: ['purchase'], limit: INBOX_LOOKUP_LIMIT }).find(entry => entry.key === inbox.key && entry.status === 'open');
      if (open) inbox.port.withdraw(open.id, 'the purchase window closed');
    } catch { /* it closes with its deadline */ }
  };
  let inboxItemId: string | undefined;
  const withdrawInbox = (): void => {
    if (input.keepOnStop?.() === true) return;
    const id = inboxItemId; inboxItemId = undefined;
    if (inbox && id) { try { inbox.port.withdraw(id, 'the purchase window closed'); } catch { /* already closed */ } }
  };
  /**
   * Wait on the window's inbox item until `deadlineMs`: the open item is reused
   * (same key) or posted again. Null at the deadline with no answer; an answer
   * that is neither option holds the purchase, as an unclear reply does.
   */
  const inboxWait = (deadlineMs: number): Promise<WindowAnswer | null> => {
    if (!inbox) return new Promise<never>(() => {});
    const item = inbox.port.postNow(purchaseInboxItem(kind, notice, deadlineMs + 60_000, purchaseId)).item;
    inboxItemId = item.id;
    return new Promise<WindowAnswer | null>((resolve, reject) => {
      const stop = new AbortController();
      const timer = setTimeout(() => { stop.abort(); resolve(null); }, Math.max(0, deadlineMs - Date.now()));
      inbox.port.waitForAnswer(item.id, AbortSignal.any([signal, stop.signal])).then((settled) => {
        // Closed without an answer (withdrawn elsewhere): the deadline still decides.
        if (settled.status !== 'answered') return;
        clearTimeout(timer);
        resolve({ answer: readInboxAnswer(settled), channel: 'owner-inbox' });
      }, (error: unknown) => {
        if (stop.signal.aborted) return;
        clearTimeout(timer); reject(error);
      });
    });
  };
  const ready = (async (): Promise<readonly ChannelDelivery[]> => {
    if (!recipients.length) {
      // The notice reached only the owner inbox: its store is the whole record.
      const inboxDeliveries = checkpoint.record.windowDeliveries ?? [];
      const answered = inboxReading();
      if (answered !== undefined) { settleFromInbox(answered); return inboxDeliveries; }
      if (!Number.isFinite(originalDeadline)) throw new PaymentReplyWindowError('source-unavailable');
      if (now() >= originalDeadline) {
        // Read again after the deadline: an answer recorded by then still counts.
        const late = inboxReading();
        if (late !== undefined) settleFromInbox(late); else historicalAnswer = null;
        return inboxDeliveries;
      }
      // The window is open again where the owner answers it: the inbox item, and
      // the purchase status the terminal apps and web UI read and answer by window id.
      const operator = replies.prepareAnswer({ purchaseId, kind, channels: [], notice, signal });
      reception = { deliveries: Promise.resolve(inboxDeliveries), cancel: () => { operator.cancel(); withdrawInbox(); },
        awaitAnswer(deadlineMs) {
          current();
          const fromOperator = operator.waitForAnswer({ deadlineMs, channels: [], deliveries: inboxDeliveries });
          // The first answer from either; silence in the inbox leaves the operator window to decide.
          return Promise.race([fromOperator, inboxWait(deadlineMs).then(answer => answer ?? fromOperator)])
            .finally(() => { operator.cancel(); withdrawInbox(); });
        } };
      return inboxDeliveries;
    }
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
    const interpreted = new Map<string, PaymentReplyReading | null>();
    const uncertainReceipts = new Set<ChannelDeliveryReceipt>();
    const readAnswers = async (window: PaymentReplyHistoryWindow | undefined, positiveAllowed: boolean): Promise<PaymentReplyReading | undefined> => {
      // The owner's inbox answer counts as a reply: an objection at once, an approval once every recipient is covered.
      const fromInbox = inboxReading();
      if (fromInbox === 'deny' || fromInbox === 'object' || fromInbox === 'not-understood') { historicalChannel = 'owner-inbox'; return fromInbox; }
      if (!window) {
        if (!positiveAllowed || fromInbox === undefined) return undefined;
        historicalChannel = 'owner-inbox';
        return fromInbox;
      }
      let positive: PaymentReplyReading | undefined;
      for (const entry of [...window.entries].sort((a, b) => Number(a.updateId) - Number(b.updateId))) {
        const matching = recipients.filter(({ receipt }) => matchesEntry(receipt, entry));
        const onTime = matching.filter(({ receipt }) => entry.receivedAtMs < cutoff(window, receipt) || entry.sentAtMs + 1000 <= cutoff(window, receipt));
        for (const { receipt } of matching) if (entry.receivedAtMs >= cutoff(window, receipt)
          && entry.sentAtMs < cutoff(window, receipt) && entry.sentAtMs + 1000 > cutoff(window, receipt)) uncertainReceipts.add(receipt);
        if (!onTime.length) continue;
        const id = JSON.stringify([entry.accountId, entry.updateId]);
        let answer = interpreted.get(id);
        if (!interpreted.has(id)) {
          // Every history entry read here matched a delivered notice's receipt: it is addressed.
          answer = await readPaymentReply(entry.text, kind, notice, signal, sourceCurrent, { addressed: true }); sourceCurrent();
          interpreted.set(id, answer ?? null);
        }
        // A correctly addressed original objection stops the purchase without
        // needing proof that no other reply was lost during downtime.
        // A reply that was not a go-ahead holds the purchase the same way.
        if (answer === 'deny' || answer === 'object' || answer === 'not-understood') { historicalChannel = 'telegram'; return answer; }
        if (positiveAllowed && onTime.length === 1 && (answer === 'approve' || answer === 'acknowledge')) {
          const recipient = onTime[0];
          if (recipient && !alreadyCovered(window, recipient.receipt) && originalSpan(window, recipient.receipt)?.acceptPositive !== false) positive ??= answer;
        }
      }
      if (positive !== undefined) { historicalChannel = 'telegram'; return positive; }
      if (positiveAllowed && fromInbox !== undefined) { historicalChannel = 'owner-inbox'; return fromInbox; }
      return undefined;
    };
    const objection = await readAnswers(original, false); sourceCurrent();
    if (objection) { historicalAnswer = objection; return checkpoint.record.windowDeliveries ?? []; }
    if (original && paymentReplyWindowReceiveCovered(original)) {
      if (now() < original.binding.deadlineMs) throw new PaymentReplyWindowError('clock-unavailable');
      // Every Telegram reply up to the deadline is known: the inbox answer, if any, is the owner's.
      const fromInbox = inboxReading();
      if (fromInbox !== undefined) settleFromInbox(fromInbox); else historicalAnswer = null;
      return checkpoint.record.windowDeliveries ?? [];
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
      const fromInbox = inboxReading();
      if (fromInbox !== undefined) settleFromInbox(fromInbox); else historicalAnswer = null;
      return checkpoint.record.windowDeliveries ?? [];
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
    reception = { deliveries: Promise.resolve([]), cancel: () => { prepared.cancel(); withdrawInbox(); },
      awaitAnswer(deadlineMs) {
        sourceCurrent();
        const fromTelegram = prepared.waitForAnswer({ deadlineMs, channels: ['telegram'], deliveries: report });
        if (!inbox) return fromTelegram;
        // The first answer from either: an inbox answer wins when it comes first, otherwise Telegram decides.
        return Promise.race([fromTelegram, inboxWait(deadlineMs).then(answer => answer ?? fromTelegram)]).finally(withdrawInbox);
      } };
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
    const report: readonly ChannelDelivery[] = Object.freeze([...recipients.filter(({ receipt }) => retained.some(span => sameReceipt(span.receipt, receipt))).map(entry => entry.delivery), ...sent,
      ...(inbox ? [inbox.delivery] : [])]);
    if (!report.length) throw new PaymentReplyWindowError('receive-uncovered');
    resumedDeadline = remaining.length ? Math.max(...retained.map(span => span.deadlineMs), now() + input.renewMinutes * 60_000) : checkpoint.record.windowDeadlineMs ?? Number.NaN;
    reception = Object.freeze({ ...reception, deliveries: Promise.resolve(report) });
    return report;
  })();
  const deliveries = ready.catch(error => { retiredOwner.abort(); reception?.cancel(); withdrawInbox(); throw error; }); void deliveries.catch(() => {});
  const deadlineMs = deliveries.then(() => { current(); return resumedDeadline; }); void deadlineMs.catch(() => {});
  return Object.freeze({ deliveries, deadlineMs, cancel() { retired = true; retiredOwner.abort(); reception?.cancel(); withdrawInbox(); },
    awaitAnswer(deadline: number) {
      current();
      if (historicalAnswer !== undefined) {
        retireOpenInboxItem();
        return Promise.resolve(historicalAnswer === null ? null : { answer: historicalAnswer, channel: historicalChannel });
      }
      if (!reception) throw new CheckoutOwnershipError(); return reception.awaitAnswer(deadline);
    } });
}
