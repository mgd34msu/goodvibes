import { captureOwnedJson } from '../gate/judgment-input.js';
import type { InFlightCheckout } from './checkout-registry.js';
import { capturePaymentNoticeReceipt } from './notice-receipt.js';
import { parseCommandAuthorityChannel } from './types.js';

const phases = ['deciding', 'awaiting-window', 'arming-payment', 'submit-pending', 'submitted'];
const tiers = ['normal', 'fast', 'fastest'];
const channels = ['tui', 'agent-terminal', 'telegram'];
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const amount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown): value is number => amount(value) && value <= 8_640_000_000_000_000;
const tier = (value: unknown): boolean => typeof value === 'string' && tiers.includes(value);

function deliveriesValid(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  const entries: readonly unknown[] = value;
  for (const entry of entries) {
    if (!object(entry) || typeof entry['channel'] !== 'string' || !channels.includes(entry['channel'])
      || seen.has(entry['channel']) || typeof entry['delivered'] !== 'boolean' || typeof entry['backfillable'] !== 'boolean') return false;
    if (Object.hasOwn(entry, 'receipt')) {
      const channel = parseCommandAuthorityChannel(entry['channel']);
      if (!channel || entry['delivered'] !== true || capturePaymentNoticeReceipt(entry['receipt'], channel) === null) return false;
    }
    seen.add(entry['channel']);
  }
  return true;
}

/** Storage validation only: a persisted checkout is not fresh execution authority.
 * Preserve unknown JSON fields, but never guess the phase, identity or amounts
 * that recovery uses to decide whether money can be released.
 */
export function captureCheckoutRecord(value: unknown): InFlightCheckout | null {
  const row = captureOwnedJson(value);
  if (!object(row) || !['purchaseId', 'sessionId', 'pageId', 'merchantDomain', 'cardId', 'item'].every(key => text(row[key]))
    || typeof row['currency'] !== 'string' || !/^[A-Z]{3}$/.test(row['currency'])
    || typeof row['phase'] !== 'string' || !phases.includes(row['phase'])
    || !timestamp(row['startedAtMs']) || !timestamp(row['updatedAtMs'])
    || !tier(row['shippingTierRequested']) || !(row['shippingTierUsed'] === null || tier(row['shippingTierUsed']))
    || !(row['reservationId'] === null || text(row['reservationId']))
    || !(row['totalMinorUnits'] === null || amount(row['totalMinorUnits']))) return null;
  const draw = row['draw'];
  if (draw !== null && (!object(draw)
    || !['itemMinorUnits', 'overageMinorUnits', 'toleranceMinorUnits', 'totalMinorUnits'].every(key => amount(draw[key])))) return null;
  const step = row['stepDown'];
  if (step !== null && (!object(step) || !tier(step['from']) || !tier(step['to'])
    || !amount(step['savedMinorUnits']) || step['reason'] !== 'overage-pool-insufficient')) return null;
  if (row['recoveryNotifiedAtMs'] !== undefined && !timestamp(row['recoveryNotifiedAtMs'])) return null;
  if (row['windowDeadlineMs'] !== undefined && !timestamp(row['windowDeadlineMs'])) return null;
  if (row['windowKind'] !== undefined && row['windowKind'] !== 'approval' && row['windowKind'] !== 'veto') return null;
  if (Object.hasOwn(row, 'windowNotice') && (typeof row['windowNotice'] !== 'string'
    || !row['windowNotice'].trim() || row['windowNotice'].length > 16_384)) return null;
  const deliveries = row['windowDeliveries'];
  if (deliveries !== undefined && !deliveriesValid(deliveries)) return null;
  return row as unknown as InFlightCheckout;
}
