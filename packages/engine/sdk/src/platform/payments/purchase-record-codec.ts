/** Parse purchase evidence without inventing missing financial facts. Retain
 * supported unknown JSON fields; a stored receipt never grants another submit. */
import { captureOwnedJson } from '../gate/judgment-input.js';
import { isValidTimezone } from './day.js';
import type { PurchaseRecord } from './purchase-record.js';

const amounts = ['itemMinorUnits', 'taxMinorUnits', 'feesMinorUnits', 'shippingMinorUnits', 'totalMinorUnits',
  'itemPoolDraw', 'overagePoolDraw', 'tolerancePoolDraw'] as const;
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const nullableText = (value: unknown): boolean => value === null || typeof value === 'string';
const tier = (value: unknown): boolean => value === 'normal' || value === 'fast' || value === 'fastest';

export function capturePurchaseRecord(value: unknown): PurchaseRecord | null {
  let row: unknown;
  try { row = captureOwnedJson(value); } catch { return null; }
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const entry = row as Record<string, unknown>;
  if (!['purchaseId', 'atUtc', 'dayKey', 'timezone', 'merchantDomain', 'item', 'windowOutcome', 'outcome'].every(key => text(entry[key]))
    || typeof entry['atUtc'] !== 'string' || !Number.isFinite(Date.parse(entry['atUtc']))
    || typeof entry['dayKey'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry['dayKey'])
    || typeof entry['timezone'] !== 'string' || !isValidTimezone(entry['timezone'])
    || typeof entry['currency'] !== 'string' || !/^[A-Z]{3}$/.test(entry['currency'])
    || !amounts.every(key => typeof entry[key] === 'number' && Number.isSafeInteger(entry[key]) && entry[key] >= 0)
    || (Object.hasOwn(entry, 'requestedMaximumMinorUnits') && (typeof entry['requestedMaximumMinorUnits'] !== 'number'
      || !Number.isSafeInteger(entry['requestedMaximumMinorUnits']) || entry['requestedMaximumMinorUnits'] < 0))
    || !tier(entry['shippingTierRequested']) || !tier(entry['shippingTierUsed'])
    || typeof entry['steppedDown'] !== 'boolean'
    || typeof entry['cardLast4'] !== 'string' || !/^(?:\d{4}|\?{4})$/.test(entry['cardLast4'])
    || (entry['windowKind'] !== 'approval' && entry['windowKind'] !== 'veto')
    || !['answeredBy', 'refusalReason', 'merchantOrderId', 'refundedAt', 'merchantQualifier'].every(key => nullableText(entry[key]))
    || (entry['refundedAt'] !== null && (typeof entry['refundedAt'] !== 'string' || !Number.isFinite(Date.parse(entry['refundedAt']))))
    || typeof entry['merchantRecognised'] !== 'boolean'
    || (entry['merchantDiscovered'] !== undefined && typeof entry['merchantDiscovered'] !== 'boolean')) return null;
  // Records predating the discovery field retain the documented owner-named
  // posture; no amount, identity, outcome or receipt time receives a default.
  return Object.freeze({ ...entry, merchantDiscovered: entry['merchantDiscovered'] === true }) as unknown as PurchaseRecord;
}
