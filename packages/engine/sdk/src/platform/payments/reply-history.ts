/** Bounded encrypted-request history facts. Neither these data nor a parsed
 * sender ID authorize a reply: native ingress must supply the live account
 * capability before appending. Receive coverage is a separate capability. */
import { isDeepStrictEqual } from 'node:util';
import { captureOwnedJson } from '../gate/judgment-input.js';
import { capturePaymentNoticeReceipt } from './notice-receipt.js';
import type { CheckoutWindowCheckpoint } from './checkout-window-checkpoint.js';
import type { ChannelDeliveryReceipt } from '../channels/delivery/types.js';
import { readTelegramPaymentReceiveSelector, type TelegramPaymentReceiveSelector } from '../channels/telegram/payment-receive-span.js';

export class PaymentReplyHistoryError extends Error {
  readonly code = 'PAYMENT_REPLY_HISTORY_UNAVAILABLE';
  constructor() { super('The original payment reply could not be saved. Receiving stopped before confirming its cursor; inspect payment and channel status.'); this.name = 'PaymentReplyHistoryError'; }
}
export interface PaymentReplyHistoryBinding {
  readonly kind: 'approval' | 'veto';
  readonly notice: string;
  readonly deadlineMs: number;
  readonly receipts: readonly ChannelDeliveryReceipt[];
}
export interface PaymentReplyHistoryEntry {
  readonly accountId: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly threadId: string | null;
  readonly messageId: string;
  readonly updateId: string;
  readonly replyToMessageId: string | null;
  readonly sentAtMs: number;
  readonly receivedAtMs: number;
  readonly text: string;
}
export interface PaymentReplyHistoryWindow {
  /** Earliest local archive custody, never inferred from an older notice. */
  readonly startedAtMs: number;
  readonly binding: PaymentReplyHistoryBinding;
  readonly entries: readonly PaymentReplyHistoryEntry[];
  /** Written only after the original native receiver has drained this exact
   * delivered window. Saved facts alone never acquire receiving authority. */
  readonly receiveCoverage?: readonly PaymentReplyReceiveCoverage[];
  readonly receiveSpans?: readonly PaymentReplyReceiveSpan[];
}
export interface PaymentReplyReceiveSpan {
  readonly receipt: ChannelDeliveryReceipt;
  readonly selector: TelegramPaymentReceiveSelector;
  readonly deadlineMs: number;
  /** A covered old recipient is not sent a replacement notice when another
   * recipient must reopen. Its old replies cannot approve the new window. */
  readonly acceptPositive: boolean;
}
export interface PaymentReplyReceiveCoverage {
  /** The live window finished with no interpreted answer. Re-reading its
   * text after restart cannot turn that recorded silence into an approval. */
  readonly resolution: 'silence';
  readonly receipt: ChannelDeliveryReceipt;
  readonly throughMs: number;
  readonly checkedAtMs: number;
}
export interface PaymentReplyHistory {
  readonly version: 1;
  readonly windows: readonly PaymentReplyHistoryWindow[];
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const reference = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const stamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
const keys = (value: Record<string, unknown>, names: readonly string[]): boolean => Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));

export function paymentReplyHistoryBinding(checkpoint: CheckoutWindowCheckpoint): PaymentReplyHistoryBinding {
  const { windowKind: kind, windowNotice: notice, windowDeadlineMs: deadlineMs, windowDeliveries } = checkpoint.record;
  if (!kind || typeof notice !== 'string' || !stamp(deadlineMs)) throw new PaymentReplyHistoryError();
  const receipts = (windowDeliveries ?? []).filter(delivery => delivery.delivered && delivery.channel === 'telegram')
    .map(delivery => {
      const receipt = capturePaymentNoticeReceipt(delivery.receipt, 'telegram');
      if (!receipt?.accountId) throw new PaymentReplyHistoryError(); return receipt;
    });
  return Object.freeze({ kind, notice, deadlineMs, receipts: Object.freeze(receipts) });
}
export function capturePaymentReplyHistoryEntry(value: unknown): PaymentReplyHistoryEntry {
  const row = captureOwnedJson(value);
  if (!object(row) || !keys(row, ['accountId', 'userId', 'conversationId', 'threadId', 'messageId', 'updateId', 'replyToMessageId', 'sentAtMs', 'receivedAtMs', 'text'])
    || !['accountId', 'userId', 'conversationId', 'messageId'].every(key => reference(row[key]))
    || !(row['threadId'] === null || reference(row['threadId'])) || !(row['replyToMessageId'] === null || reference(row['replyToMessageId']))
    || typeof row['updateId'] !== 'string' || !/^(?:0|[1-9]\d{0,15})$/.test(row['updateId']) || !Number.isSafeInteger(Number(row['updateId']))
    || !stamp(row['sentAtMs']) || !stamp(row['receivedAtMs']) || typeof row['text'] !== 'string' || !row['text'].trim() || row['text'].length > 16_384) throw new PaymentReplyHistoryError();
  return row as unknown as PaymentReplyHistoryEntry;
}
export function historyEntryIdentity(entry: PaymentReplyHistoryEntry): string {
  return JSON.stringify([entry.accountId, entry.updateId]);
}
export function capturePaymentReplyReceiveCoverage(value: unknown, binding: PaymentReplyHistoryBinding): PaymentReplyReceiveCoverage {
  const row = captureOwnedJson(value);
  if (!object(row) || !keys(row, ['resolution', 'receipt', 'throughMs', 'checkedAtMs']) || row['resolution'] !== 'silence'
    || !stamp(row['throughMs']) || row['throughMs'] > binding.deadlineMs
    || !stamp(row['checkedAtMs']) || row['checkedAtMs'] < row['throughMs']) throw new PaymentReplyHistoryError();
  const receipt = capturePaymentNoticeReceipt(row['receipt'], 'telegram');
  if (!receipt || !binding.receipts.some(original => isDeepStrictEqual(original, receipt))) throw new PaymentReplyHistoryError();
  return Object.freeze({ resolution: 'silence', receipt, throughMs: row['throughMs'], checkedAtMs: row['checkedAtMs'] });
}
export function capturePaymentReplyReceiveSpans(value: unknown, binding: PaymentReplyHistoryBinding, purchaseId: string): readonly PaymentReplyReceiveSpan[] {
  if (!Array.isArray(value) || value.length > binding.receipts.length) throw new PaymentReplyHistoryError();
  const result: PaymentReplyReceiveSpan[] = [];
  for (const entry of value) {
    if (!object(entry) || !keys(entry, ['receipt', 'selector', 'deadlineMs', 'acceptPositive']) || !stamp(entry['deadlineMs'])
      || entry['deadlineMs'] > binding.deadlineMs || typeof entry['acceptPositive'] !== 'boolean') throw new PaymentReplyHistoryError();
    const receipt = capturePaymentNoticeReceipt(entry['receipt'], 'telegram');
    const selector = readTelegramPaymentReceiveSelector(entry['selector']);
    if (!receipt || selector.accountId !== receipt.accountId || selector.purchaseId !== purchaseId
      || !binding.receipts.some(original => isDeepStrictEqual(original, receipt))
      || result.some(previous => isDeepStrictEqual(previous.receipt, receipt))) throw new PaymentReplyHistoryError();
    if (selector.registeredAtMs > entry['deadlineMs']) throw new PaymentReplyHistoryError();
    result.push(Object.freeze({ receipt, selector, deadlineMs: entry['deadlineMs'], acceptPositive: entry['acceptPositive'] }));
  }
  return Object.freeze(result);
}
export function paymentReplyWindowReceiveCovered(window: PaymentReplyHistoryWindow): boolean {
  return window.binding.receipts.length > 0 && window.binding.receipts.every(receipt => window.receiveCoverage?.some(
    coverage => coverage.throughMs === (window.receiveSpans?.find(span => isDeepStrictEqual(span.receipt, receipt))?.deadlineMs ?? window.binding.deadlineMs)
      && isDeepStrictEqual(coverage.receipt, receipt)));
}
export function capturePaymentReplyHistory(value: unknown, checkpoint: CheckoutWindowCheckpoint): PaymentReplyHistory {
  const row = captureOwnedJson(value), current = paymentReplyHistoryBinding(checkpoint);
  if (!object(row) || !keys(row, ['version', 'windows']) || row['version'] !== 1 || !Array.isArray(row['windows'])
    || row['windows'].length < 1 || row['windows'].length > 16) throw new PaymentReplyHistoryError();
  let count = 0; const bindings = new Set<string>(), eventIds = new Set<string>();
  const windows = row['windows'].map((value): PaymentReplyHistoryWindow => {
    if (!object(value) || !keys(value, ['startedAtMs', 'binding', 'entries', ...(Object.hasOwn(value, 'receiveCoverage') ? ['receiveCoverage'] : []),
      ...(Object.hasOwn(value, 'receiveSpans') ? ['receiveSpans'] : [])]) || !stamp(value['startedAtMs'])
      || !object(value['binding']) || !Array.isArray(value['entries'])) throw new PaymentReplyHistoryError();
    const startedAtMs = value['startedAtMs'];
    const raw = value['binding'];
    if (!keys(raw, ['kind', 'notice', 'deadlineMs', 'receipts']) || (raw['kind'] !== 'approval' && raw['kind'] !== 'veto')
      || typeof raw['notice'] !== 'string' || raw['notice'].length > 65_536 || !stamp(raw['deadlineMs'])
      || !Array.isArray(raw['receipts']) || raw['receipts'].length > 256) throw new PaymentReplyHistoryError();
    const receipts = raw['receipts'].map(receipt => {
      const captured = capturePaymentNoticeReceipt(receipt, 'telegram'); if (!captured?.accountId) throw new PaymentReplyHistoryError(); return captured;
    });
    const binding = Object.freeze({ kind: raw['kind'], notice: raw['notice'], deadlineMs: raw['deadlineMs'], receipts: Object.freeze(receipts) });
    const receiveSpans = Object.hasOwn(value, 'receiveSpans') ? capturePaymentReplyReceiveSpans(value['receiveSpans'], binding, checkpoint.record.purchaseId) : undefined;
    if (receiveSpans?.some(span => span.selector.sinceMs > startedAtMs || span.selector.registeredAtMs > binding.deadlineMs)) throw new PaymentReplyHistoryError();
    let receiveCoverage: readonly PaymentReplyReceiveCoverage[] | undefined;
    if (Object.hasOwn(value, 'receiveCoverage')) {
      if (!Array.isArray(value['receiveCoverage']) || value['receiveCoverage'].length > receipts.length) throw new PaymentReplyHistoryError();
      const covered = value['receiveCoverage'].map(coverage => capturePaymentReplyReceiveCoverage(coverage, binding));
      if (covered.some((coverage, index) => coverage.throughMs !== (receiveSpans?.find(span => isDeepStrictEqual(span.receipt, coverage.receipt))?.deadlineMs ?? binding.deadlineMs)
        || covered.slice(0, index).some(previous => isDeepStrictEqual(previous.receipt, coverage.receipt)))) throw new PaymentReplyHistoryError();
      receiveCoverage = Object.freeze(covered);
    }
    const key = JSON.stringify([binding.kind, binding.notice, binding.deadlineMs,
      binding.receipts.map(receipt => [receipt.surfaceKind, receipt.accountId, receipt.conversationId, receipt.threadId ?? null, receipt.messageId])]);
    if (bindings.has(key)) throw new PaymentReplyHistoryError(); bindings.add(key);
    const entries = value['entries'].map(capturePaymentReplyHistoryEntry); count += entries.length;
    if (count > 256) throw new PaymentReplyHistoryError();
    for (const entry of entries) {
      const id = historyEntryIdentity(entry);
      if (eventIds.has(id) || entry.receivedAtMs < startedAtMs || !binding.receipts.some(receipt => receipt.accountId === entry.accountId && receipt.conversationId === entry.conversationId
        && (receipt.threadId ?? null) === entry.threadId && (entry.replyToMessageId === null || entry.replyToMessageId === receipt.messageId)
        && /^[1-9]\d{0,15}$/.test(entry.messageId) && Number.isSafeInteger(Number(entry.messageId)) && Number(entry.messageId) > Number(receipt.messageId))) throw new PaymentReplyHistoryError();
      eventIds.add(id);
    }
    return Object.freeze({ startedAtMs, binding, entries: Object.freeze(entries), ...(receiveCoverage ? { receiveCoverage } : {}),
      ...(receiveSpans ? { receiveSpans } : {}) });
  });
  if (!isDeepStrictEqual(windows.at(-1)?.binding, current)) throw new PaymentReplyHistoryError();
  return Object.freeze({ version: 1, windows: Object.freeze(windows) });
}
