import { isDeepStrictEqual } from 'node:util';
import { captureOwnedJson } from '../gate/judgment-input.js';
import { captureCheckoutRecord } from './checkout-record.js';
import { readCheckoutReadingInput } from './checkout-reading-input.js';
import { extractCheckout, type RawCheckoutReading } from './checkout-extraction.js';
import type { InFlightCheckout } from './checkout-registry.js';
import type { CheckoutTerms } from './checkout-page.js';
import type { CheckoutOperationOwnership } from './checkout-ownership.js';
import type { PaymentNoticeWindow } from './payment-ports.js';

/** The quote actually shown in the durable window, including after a reprice.
 * These are retained facts; neither parsing nor storing them grants execution. */
export interface CheckoutWindowCheckpoint {
  readonly record: InFlightCheckout;
  readonly reading: RawCheckoutReading;
  /** Earlier checkpoints omit this exact selected-option/control binding. */
  readonly terms?: CheckoutTerms;
}

/** Construction-only continuation after the host has restored the original
 * grant, executor lease, native page and reply history. This callback owns
 * which delivered channels retain their deadline or need reopening. Neither
 * the callback nor execution ownership is accepted from wire/stored JSON. */
export interface CheckoutWindowResumption {
  readonly checkpoint: CheckoutWindowCheckpoint;
  readonly prepare: (owner: CheckoutOperationOwnership) => PaymentNoticeWindow & { readonly deadlineMs: Promise<number> };
}

export function captureCheckoutWindowCheckpoint(value: unknown): CheckoutWindowCheckpoint {
  const input = captureOwnedJson(value);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2 + (Object.hasOwn(input, 'terms') ? 1 : 0)
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
  const terms = 'terms' in input ? input.terms : undefined;
  if (Object.hasOwn(input, 'terms')) {
    const keys = ['submitTarget', 'merchantDomain', 'currency', 'lines', 'taxMinorUnits', 'feesMinorUnits', 'feeLabels', 'shippingLabel', 'shippingMinorUnits', 'totalMinorUnits'];
    if (!terms || typeof terms !== 'object' || Array.isArray(terms) || Object.keys(terms).length !== keys.length
      || keys.some(key => !Object.hasOwn(terms, key))) throw new Error('The payment window checkpoint is unavailable');
    const selected = terms as Record<string, unknown>, checkout = extracted.checkout;
    if (typeof selected['submitTarget'] !== 'string' || !selected['submitTarget'].trim()
      || selected['merchantDomain'] !== record.merchantDomain || selected['currency'] !== record.currency
      || selected['taxMinorUnits'] !== checkout.taxMinorUnits || selected['feesMinorUnits'] !== checkout.feesMinorUnits
      || selected['totalMinorUnits'] !== record.totalMinorUnits || !isDeepStrictEqual(selected['lines'], checkout.lines)
      || !isDeepStrictEqual(selected['feeLabels'], checkout.feeLabels)
      || !checkout.shippingOptions.some(option => option.rawLabel === selected['shippingLabel'] && option.costMinorUnits === selected['shippingMinorUnits']
        && checkout.subtotalMinorUnits + option.costMinorUnits === record.totalMinorUnits)) throw new Error('The payment window checkpoint is unavailable');
  }
  return Object.freeze({ record, reading: input.reading as unknown as RawCheckoutReading,
    ...(terms === undefined ? {} : { terms: terms as unknown as CheckoutTerms }) });
}
