/**
 * money.ts, an amount is a number of minor units IN a currency.
 *
 * `Money` pairs the two so neither travels alone: an approval, a purchase
 * window, a standing authorization or a budget entry holds a `Money`, and
 * adding or comparing two amounts of different currencies throws
 * `CurrencyMismatchError` instead of quietly re-denominating one of them. A
 * currency change is therefore a different purchase, never the same approval
 * read in another unit.
 *
 * A purchase is `purchased` only through `settleSubmission` with
 * `OrderEvidence` tied to the one submit that happened (`SubmissionDispatch`,
 * minted at the click and journaled before it); anything less stays
 * `submitted-unverified`.
 *
 * Cost: none on an ordinary turn; one sha256 per submit for the cart digest,
 * kept in the record already written before the click.
 */
import { createHash } from 'node:crypto';
import { formatMinorUnits } from './message.js';
import type { CurrencyCode, MinorUnits } from './types.js';

export interface Money {
  readonly minor: MinorUnits;
  readonly currency: CurrencyCode;
}

/** Two amounts in different currencies were added or compared; nothing was computed. */
export class CurrencyMismatchError extends Error {
  readonly code = 'CURRENCY_MISMATCH';
  constructor(readonly left: CurrencyCode, readonly right: CurrencyCode) {
    super(`An amount in ${left} cannot be combined with one in ${right}; a change of currency is a different purchase.`);
    this.name = 'CurrencyMismatchError';
  }
}

/** An amount; refuses anything but a non-negative safe integer number of minor units. */
export function money(minor: number, currency: CurrencyCode): Money {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new RangeError(`An amount is a non-negative whole number of minor units, not ${String(minor)}.`);
  return Object.freeze({ minor, currency });
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function addMoney(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(a.minor + b.minor, a.currency);
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  sameCurrency(a, b);
  return a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0;
}

/** The amount as the owner reads it (`$25.00`, `CHF 12.00`); the one payments formatter (message.ts formatMinorUnits) renders it. */
export function formatMoney(value: Money): string {
  return formatMinorUnits(value.minor, value.currency);
}

/** One submit of one cart: everything that claims a purchase happened must name it. */
export interface SubmissionDispatch {
  readonly purchaseId: string;
  /** Minted at the click and journaled before it. */
  readonly dispatchId: string;
  /** sha256 of the matched lines, their quantities and the total (`cartDigest`). */
  readonly cartDigest: string;
  readonly total: Money;
  readonly merchantDomain: string;
}

/** The digest a dispatch names: the matched lines in order, each label, quantity and unit amount, and the total. */
export function cartDigest(lines: readonly { readonly label: string; readonly quantity: number; readonly unitMinorUnits: MinorUnits }[], total: Money): string {
  const canonical = JSON.stringify({
    lines: lines.map((line) => [line.label, line.quantity, line.unitMinorUnits]),
    total: [total.minor, total.currency],
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** What shows that THIS submit placed an order: an order number, or a confirmation that shows this dispatch's total. */
export type OrderEvidence =
  | { readonly kind: 'order-number'; readonly dispatch: SubmissionDispatch; readonly orderId: string; readonly landedFrom: 'this-submit' }
  | { readonly kind: 'confirmation-with-total'; readonly dispatch: SubmissionDispatch; readonly totalShown: Money; readonly landedFrom: 'this-submit' };

/**
 * `purchased` only from evidence for this very dispatch: the same purchase,
 * dispatch, cart digest and merchant, and either a non-empty order number or
 * the dispatch's own total shown in its own currency. Anything else, no
 * evidence included, stays `submitted-unverified` for the owner to reconcile.
 */
export function settleSubmission(dispatch: SubmissionDispatch, evidence: OrderEvidence | null): 'purchased' | 'submitted-unverified' {
  if (evidence === null || evidence.landedFrom !== 'this-submit') return 'submitted-unverified';
  const named = evidence.dispatch;
  if (named.purchaseId !== dispatch.purchaseId || named.dispatchId !== dispatch.dispatchId
    || named.cartDigest !== dispatch.cartDigest || named.merchantDomain !== dispatch.merchantDomain) return 'submitted-unverified';
  if (evidence.kind === 'order-number') return evidence.orderId.trim().length > 0 ? 'purchased' : 'submitted-unverified';
  if (evidence.totalShown.currency !== dispatch.total.currency) return 'submitted-unverified';
  return compareMoney(evidence.totalShown, dispatch.total) === 0 ? 'purchased' : 'submitted-unverified';
}
