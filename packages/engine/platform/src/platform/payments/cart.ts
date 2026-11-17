import { requireDecisionFeature } from '../runtime/decision-policy.js';
/**
 * cart.ts, the cart must contain what the owner asked for and nothing else.
 *
 * ── Never add filler items ────────────────────────────────────────────────
 *
 * Design rule, and an invariant rather than a preference: never add items to
 * cross a free-shipping threshold. Buying something the owner did not ask for
 * in order to make the delivery line look better is still buying something
 * they did not ask for, and "it was cheaper overall" is the argument every
 * version of this mistake makes.
 *
 * There is deliberately no free-shipping-threshold logic anywhere in this
 * capability. Its ABSENCE is the design, and absence is hard to test, so the
 * enforcement is positive: the cart is compared against the request immediately
 * before payment and any line the owner did not ask for aborts the purchase.
 *
 * ── Subscriptions and recurring charges ───────────────────────────────────
 *
 * Refused. A daily budget cannot describe a charge that renews unattended next
 * month; nothing here would notice a renewal, let alone stop one. Enrolling
 * the owner in a recurring charge on a capability whose entire safety story is
 * a daily limit is the most expensive kind of silent hole.
 *
 * Detection errs toward refusing, on purpose: a false refusal costs the owner
 * a manual purchase, a false accept costs them a charge nobody is watching.
 *
 * ── What is read and what is code ──────────────────────────────────────────
 *
 * Which requested item a cart line is, is read by Jev
 * (`engine.payments.cart-line`): the merchant names a product in its own
 * words, so label equality refused correct carts and could not tell an add-on
 * from the item. Whether the checkout sets up a repeating charge is read by
 * Jev (`engine.payments.recurring-charge`) in place of a keyword list.
 * Quantities are compared in code: two counts.
 */
import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { mapLimit } from '@goodvibes-jev/judgment';
import { sanitizeNoticeField } from '../security/notice-text.js';
import { cartLine, requestedLineId } from './batteries/cart-line.js';
import { orderSummaryView, recurringCharge } from './batteries/recurring-charge.js';
import type { MinorUnits } from './types.js';
import { captureCheckoutOwnership, type CheckoutOperationOwnership } from './checkout-ownership.js';
import { captureOwnedJson } from '../gate/judgment-input.js';

/** The decision sites the cart readings are logged under. */
export const CART_LINE_SITE = 'payments.cart-line';
export const RECURRING_CHARGE_SITE = 'payments.recurring-charge';

/** How many cart lines are read at once. */
const CART_LINE_CONCURRENCY = 4;

export interface CartLine {
  /** The merchant's own label. Used for comparison and audit, never rendered in a prompt. */
  readonly label: string;
  readonly quantity: number;
  readonly unitMinorUnits: MinorUnits;
}

export interface RequestedLine {
  readonly label: string;
  readonly quantity: number;
}

export interface CartCheck {
  readonly ok: boolean;
  /**
   * `cart-mismatch` when a reading settled that a line is not what the owner
   * asked for (or a quantity is off); `cart-unconfirmed` when a reading could
   * not settle it either way. Null when the cart matches.
   */
  readonly code: 'cart-mismatch' | 'cart-unconfirmed' | null;
  /** Lines present in the cart that the owner did not ask for. */
  readonly unexpected: readonly CartLine[];
  /** Lines the reading could not tie to a requested item or rule out. */
  readonly unconfirmed: readonly CartLine[];
  /** Lines the owner asked for that are missing. */
  readonly missing: readonly RequestedLine[];
  readonly reason: string | null;
}

/** What the reading settled about one cart line. */
type LineMatch = { readonly kind: 'matched'; readonly index: number } | { readonly kind: 'not-matched' } | { readonly kind: 'unsettled' };

/**
 * Which requested item this cart line is. A line is that item only when the
 * reading acts on it; a reading that acts on "none" settles that it is not a
 * requested item; anything short of acting settles nothing.
 */
async function requestedIndexOf(line: CartLine, requested: readonly RequestedLine[], options: CheckoutOperationOwnership): Promise<LineMatch> {
  const owner = captureJudgmentPort(CART_LINE_SITE, options);
  const candidates = requested.map((entry, index) => ({ id: requestedLineId(index), content: { requested_item: entry.label } }));
  const selection = await cartLine.select(owner.port, { cart_line: line.label }, candidates, { site: CART_LINE_SITE, signal: owner.signal });
  owner.assertCurrent();
  if (selection.outcome !== 'act') {
    selection.recordAction('unsettled');
    return { kind: 'unsettled' };
  }
  const index = selection.chosen === undefined ? -1 : candidates.findIndex((candidate) => candidate.id === selection.chosen);
  selection.recordAction(index === -1 ? 'not a requested item' : `requested item ${index}`);
  return index === -1 ? { kind: 'not-matched' } : { kind: 'matched', index };
}

/**
 * Compare the cart against the request, immediately before payment.
 *
 * Quantity is checked too: turning a request for one into a cart of three is the
 * same defect as adding a second product, and only one of those would be caught
 * by comparing items alone.
 */
export async function assertCartMatchesRequest(
  cart: readonly CartLine[],
  requested: readonly RequestedLine[],
  options: CheckoutOperationOwnership = {},
): Promise<CartCheck> {
  requireDecisionFeature('automated checkout cart comparison');
  const owner = captureCheckoutOwnership(options);
  const captured = captureOwnedJson({ cart, requested }) as unknown as { cart: readonly CartLine[]; requested: readonly RequestedLine[] };
  cart = captured.cart; requested = captured.requested;
  if (requested.some(line => !Number.isSafeInteger(line.quantity) || line.quantity <= 0)
    || cart.some(line => !Number.isSafeInteger(line.quantity) || line.quantity <= 0)) {
    return { ok: false, code: 'cart-mismatch', unexpected: [...cart], unconfirmed: [], missing: [...requested], reason: 'Refused: cart and requested quantities must be positive whole counts.' };
  }
  const matches: readonly LineMatch[] = requested.length === 0
    ? cart.map((): LineMatch => ({ kind: 'not-matched' }))
    : await mapLimit(cart, CART_LINE_CONCURRENCY, (line) => requestedIndexOf(line, requested, owner));
  owner.assertCurrent();

  const unexpected: CartLine[] = [];
  const unconfirmed: CartLine[] = [];
  const quantities = new Map<number, number>();
  cart.forEach((line, position) => {
    const found = matches[position] ?? { kind: 'unsettled' };
    if (found.kind === 'unsettled') {
      unconfirmed.push(line);
      return;
    }
    const match = found.kind === 'matched' ? requested[found.index] : undefined;
    if (found.kind !== 'matched' || match === undefined) {
      unexpected.push(line);
      return;
    }
    const total = (quantities.get(found.index) ?? 0) + line.quantity;
    if (!Number.isSafeInteger(total) || total > match.quantity) unexpected.push(line);
    quantities.set(found.index, total);
  });

  const missing = requested.filter((line, index) => quantities.get(index) !== line.quantity);

  if (unexpected.length === 0 && unconfirmed.length === 0 && missing.length === 0) {
    return { ok: true, code: null, unexpected: [], unconfirmed: [], missing: [], reason: null };
  }

  // An unsettled reading is not a finding about the merchant. When it is the
  // only problem (a missing quantity may be that very line), the refusal says
  // what is true: the line could not be confirmed, not that the shop added it.
  if (unexpected.length === 0 && unconfirmed.length > 0) {
    const asked = requested.length === 1
      ? sanitizeNoticeField(requested[0]?.label ?? '', 60)
      : `one of the items you asked for (${requested.map((line) => sanitizeNoticeField(line.label, 60)).join(', ')})`;
    const labels = unconfirmed.map((line) => `'${sanitizeNoticeField(line.label, 60)}'`).join(', ');
    return {
      ok: false,
      code: 'cart-unconfirmed',
      unexpected: [],
      unconfirmed,
      missing,
      reason: `Refused before paying: I could not confirm that ${labels} ${unconfirmed.length === 1 ? 'is' : 'are'} ${asked}. `
        + 'Nothing was bought. Check the cart, or name the item more exactly, then ask me again.',
    };
  }

  const parts: string[] = [];
  if (unexpected.length > 0) {
    parts.push(
      `the cart contains ${unexpected.length} line(s) you did not ask for `
      // The merchant chose these labels, and this reason is delivered to a
      // channel. Neutralised, not interpolated raw, see security/notice-text.ts.
      + `(${unexpected.map((line) => sanitizeNoticeField(line.label, 60)).join(', ')})`,
    );
  }
  if (missing.length > 0) {
    // These are the OWNER's labels, but they are sanitized too: a guarantee
    // that holds only while every call site threads provenance correctly is not
    // a guarantee.
    parts.push(`it does not have the requested quantity of ${missing.map((line) => sanitizeNoticeField(line.label, 60)).join(', ')}`);
  }
  if (unconfirmed.length > 0) {
    parts.push(`I could not confirm ${unconfirmed.map((line) => sanitizeNoticeField(line.label, 60)).join(', ')} either`);
  }
  return {
    ok: false,
    code: 'cart-mismatch',
    unexpected,
    unconfirmed,
    missing,
    reason:
      `Refused before paying: ${parts.join(', and ')}. `
      + 'I never add items you did not ask for, including to reach free shipping.',
  };
}

export interface RecurringCheck {
  /** True unless the reading confidently settled a single payment. */
  readonly recurring: boolean;
  /**
   * `one-off`: a confident no. `recurring`: a confident yes. `not-confirmed-one-off`:
   * anything else; the reading could not confirm a single payment, and the
   * reason says which way it leaned. Both refusals stop the purchase.
   */
  readonly outcome: 'one-off' | 'recurring' | 'not-confirmed-one-off';
  readonly code: 'recurring-charge' | 'recurring-unconfirmed' | null;
  readonly reason: string | null;
}

/**
 * Whether the order summary sets up a repeating charge, read by Jev.
 *
 * Takes the checkout's own text, which IS untrusted page content, and is used
 * here only to decide whether to REFUSE. Untrusted content can always talk us
 * out of an action; the rule it may never do is talk us into one. Reading it to
 * find a reason to stop is the safe direction of that asymmetry, and it is why
 * anything but a confident no refuses. The refusal says which it was: a
 * confident yes, or a reading that could not confirm a single payment.
 */
export async function detectRecurringCharge(orderSummaryText: string, options: CheckoutOperationOwnership = {}): Promise<RecurringCheck> {
  requireDecisionFeature('checkout recurring-charge interpretation');
  const owner = captureJudgmentPort(RECURRING_CHARGE_SITE, captureCheckoutOwnership(options));
  const state = orderSummaryView(orderSummaryText);
  const run = await recurringCharge.run(owner.port, state, { site: RECURRING_CHARGE_SITE, signal: owner.signal });
  owner.assertCurrent();
  const reading = run.readings.recurring;
  const outcome: RecurringCheck['outcome'] = reading.outcome !== 'act' ? 'not-confirmed-one-off'
    : reading.verdict === 'no' ? 'one-off' : reading.verdict === 'yes' ? 'recurring' : 'not-confirmed-one-off';
  run.recordAction(outcome === 'one-off' ? 'one-off charge' : outcome === 'recurring' ? 'refused as recurring' : 'refused as not confirmed one-off');
  if (outcome === 'one-off') return { recurring: false, outcome, code: null, reason: null };
  if (outcome === 'recurring') {
    return {
      recurring: true,
      outcome,
      code: 'recurring-charge',
      reason:
        'Refused: this checkout looks like it sets up a charge that repeats, a subscription, a renewal, '
        + 'a trial that turns into a paid plan or a card kept for later charges. A daily budget cannot '
        + 'describe something that renews on its own, and I have no way to stop the next one. Buy this '
        + 'one yourself if you want it.',
    };
  }
  // The reading did not act, so say which way it leaned: a lean towards yes is
  // not "nothing indicated a subscription".
  const lean = reading.verdict === 'yes'
    ? 'The reading leaned towards a repeating charge but was not sure.'
    : reading.verdict === 'no'
      ? 'The reading leaned towards a single payment but was not sure enough to buy.'
      : 'The reading could not tell either way.';
  return {
    recurring: true,
    outcome,
    code: 'recurring-unconfirmed',
    reason:
      `Refused: I could not confirm this is a single payment, so I did not buy it; the summary I read was ${String(orderSummaryText.length)} characters. `
      + `${lean} Start the purchase again with an order summary that holds only this order, `
      + 'without adverts or account offers, or buy this one yourself.',
  };
}
