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
  if (keys.some(key => !['surfaceKind', 'conversationId', 'messageId', 'threadId'].includes(key))
    || row['surfaceKind'] !== channel || !CHANNEL_DELIVERY_SURFACE_KINDS.some(kind => kind === row['surfaceKind'])
    || !reference(row['conversationId']) || !reference(row['messageId'])
    || (Object.hasOwn(row, 'threadId') && !reference(row['threadId']))) return null;
  return captured as unknown as ChannelDeliveryReceipt;
}
