import { isDeepStrictEqual } from 'node:util';
import { captureOwnedJson } from '../gate/judgment-input.js';
import { captureCheckoutRecord } from './checkout-record.js';
import { readCheckoutReadingInput } from './checkout-reading-input.js';
import { extractCheckout, type RawCheckoutReading } from './checkout-extraction.js';
import type { InFlightCheckout } from './checkout-registry.js';

/** The quote actually shown in the durable window, including after a reprice.
 * These are retained facts; neither parsing nor storing them grants execution. */
export interface CheckoutWindowCheckpoint {
  readonly record: InFlightCheckout;
  readonly reading: RawCheckoutReading;
}

export function captureCheckoutWindowCheckpoint(value: unknown): CheckoutWindowCheckpoint {
  const input = captureOwnedJson(value);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2
    || !('record' in input) || !('reading' in input)) throw new Error('The payment window checkpoint is unavailable');
  const record = captureCheckoutRecord(input.record), reading = readCheckoutReadingInput(input.reading);
  if (!record || record.phase !== 'awaiting-window' || !record.draw || !record.reservationId || record.totalMinorUnits === null
    || record.totalMinorUnits !== record.draw.totalMinorUnits || record.shippingTierUsed === null
    || record.windowDeadlineMs === undefined || record.windowKind === undefined || record.windowNotice === undefined
    || record.windowDeliveries === undefined || !reading.ok
    || !isDeepStrictEqual(captureOwnedJson(reading.reading), input.reading)) throw new Error('The payment window checkpoint is unavailable');
  const extracted = extractCheckout(reading.reading, record.currency);
  if (!extracted.ok || extracted.checkout.itemMinorUnits !== record.draw.itemMinorUnits
    || record.draw.itemMinorUnits + record.draw.overageMinorUnits + record.draw.toleranceMinorUnits !== record.totalMinorUnits
    || !extracted.checkout.shippingOptions.some(option => extracted.checkout.itemMinorUnits + extracted.checkout.taxMinorUnits
      + extracted.checkout.feesMinorUnits + option.costMinorUnits === record.totalMinorUnits)) throw new Error('The payment window checkpoint is unavailable');
  return Object.freeze({ record, reading: input.reading as unknown as RawCheckoutReading });
}
