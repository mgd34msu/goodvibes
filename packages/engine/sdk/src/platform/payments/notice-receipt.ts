/** Correlation evidence only. A delivery receipt never grants another submit,
 * proves absence of a missed reply, or establishes that history is available. */
import { CHANNEL_DELIVERY_SURFACE_KINDS, type ChannelDeliveryReceipt } from '../channels/delivery/types.js';
import { captureOwnedJson } from '../gate/judgment-input.js';
import type { CommandAuthorityChannel } from './types.js';

const reference = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

export function capturePaymentNoticeReceipt(value: unknown, channel: CommandAuthorityChannel): ChannelDeliveryReceipt | null {
  let captured: unknown;
  try { captured = captureOwnedJson(value); } catch { return null; }
  if (!captured || typeof captured !== 'object' || Array.isArray(captured)) return null;
  const row = captured as Record<string, unknown>, keys = Object.keys(row);
  if (keys.some(key => !['surfaceKind', 'conversationId', 'messageId', 'threadId', 'accountId'].includes(key))
    || row['surfaceKind'] !== channel || !CHANNEL_DELIVERY_SURFACE_KINDS.some(kind => kind === row['surfaceKind'])
    || !reference(row['conversationId']) || !reference(row['messageId'])
    || (Object.hasOwn(row, 'accountId') && !reference(row['accountId']))
    || (channel === 'telegram' && typeof row['accountId'] === 'string'
      && (!/^[1-9]\d{0,15}$/.test(row['accountId']) || !Number.isSafeInteger(Number(row['accountId']))))
    || (Object.hasOwn(row, 'threadId') && !reference(row['threadId']))) return null;
  return captured as unknown as ChannelDeliveryReceipt;
}

export interface PaymentReceiptCorrelation {
  readonly conversationId: string;
  readonly threadId?: string | undefined;
  readonly accountId?: string | undefined;
  readonly messageId?: string | undefined;
  readonly replyToMessageId?: string | undefined;
}
/** Match only actual recipient/topic and a later message, preserving explicit
 * replies to the exact notice. A matching account ID is still not authority. */
export function matchesPaymentNoticeReceipt(receipt: ChannelDeliveryReceipt, context: PaymentReceiptCorrelation): boolean {
  if (receipt.conversationId !== context.conversationId || receipt.threadId !== context.threadId) return false;
  if (receipt.accountId !== undefined && context.accountId !== undefined && receipt.accountId !== context.accountId) return false;
  if (context.replyToMessageId !== undefined && context.replyToMessageId !== receipt.messageId) return false;
  if (receipt.surfaceKind === 'telegram') {
    const id = (value: string | undefined): value is string => value !== undefined && /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
    if (!id(context.messageId) || !id(receipt.messageId) || Number(context.messageId) <= Number(receipt.messageId)) return false;
  }
  return true;
}
