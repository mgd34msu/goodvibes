/**
 * message.ts, what the approval and veto prompts say, and why no page can
 * influence a single character of it.
 *
 * The attack this exists to stop: if merchant page text can reach the message,
 * whoever controls that page writes what the owner reads on their phone.
 * "Approve $12 for coffee?" attached to a $1,200 order is a complete compromise
 * of the human check, and it looks perfectly normal.
 *
 * So the message is rendered from a CLOSED STRUCT OF TYPED SCALARS, and there is
 * no field in it that can carry free text from a page:
 *
 *   merchantDomain  registrableDomain() of the VALIDATED url, computed by us,
 *                   never the page's own claimed name
 *   item            OwnerSuppliedText, a branded type only constructible from
 *                   an owner-direct turn, so assigning page text is a compile
 *                   error. (And if the item only exists on the page, the taint
 *                   gate already refused the purchase.)
 *   amounts         integer minor units, re-rendered by OUR formatter. A page
 *                   string never passes through. A value that will not parse to
 *                   a plain non-negative integer refuses rather than rendering.
 *   currency        validated ISO-4217
 *
 * The pools are shown next to the total on purpose: an inflated number is much
 * easier to catch beside the budget it is about to eat than on its own.
 */
import { isPlainHostname, sanitizeNoticeField, sanitizeOwnerNoticeField } from '../security/notice-text.js';
import type { PoolSnapshot } from './budget.js';
import { minorUnitExponent } from './money-parsing.js';
import type {
  CurrencyCode,
  MinorUnits,
  OwnerSuppliedText,
  ShippingStepDown,
  ShippingTier,
  PurchaseApprovalReason,
} from './types.js';

/**
 * The merchant identity the owner is shown.
 *
 * It is the registrable domain computed by `registrableDomain()` from the
 * VALIDATED checkout url, never the page's own claimed name, because a page can
 * call itself anything. A computed hostname always passes `isPlainHostname`; if
 * one ever does not, the identity did not come from where the caller believed,
 * and the honest response is a placeholder rather than rendering it.
 */
function renderMerchant(domain: string): string {
  return isPlainHostname(domain) ? domain : '(merchant identity unavailable)';
}

/**
 * The item line.
 *
 * `OwnerSuppliedText` is only constructible from an owner-direct turn, so this
 * should already be the owner's words rather than a product title off a page. It is
 * still neutralised: the branded type is a compile-time guarantee, and a
 * compile-time guarantee does not survive a call site that threads provenance
 * wrongly. Underscore is kept for legibility since it cannot build a link.
 */
function renderItem(item: OwnerSuppliedText): string {
  return sanitizeOwnerNoticeField(item, 100);
}

export interface PurchaseFacts {
  readonly merchantDomain: string;
  readonly item: OwnerSuppliedText;
  readonly itemMinorUnits: MinorUnits;
  /** Reduction lines the checkout showed, each the amount it took off the items. */
  readonly discounts?: readonly { readonly label: string; readonly amountMinorUnits: MinorUnits }[] | undefined;
  readonly taxMinorUnits: MinorUnits;
  readonly feesMinorUnits: MinorUnits;
  readonly shippingMinorUnits: MinorUnits;
  readonly totalMinorUnits: MinorUnits;
  readonly currency: CurrencyCode;
  readonly cardLast4: string;
  readonly shippingTier: ShippingTier;
  readonly stepDown: ShippingStepDown | null;
  readonly poolsAfter: PoolSnapshot;
  readonly requestedMaximumMinorUnits?: MinorUnits | undefined;
  readonly approvalReasons?: readonly PurchaseApprovalReason[] | undefined;
  /** Over a limit: which limit and by how much, with the amounts (the budget decision's own words). */
  readonly limitReason?: string | undefined;
  /**
   * What no decision model checked, one already-neutralised line each (the
   * cart lines as the merchant labelled them, whether the charge repeats,
   * delivery speed). Present only with the `not-checked` approval reason.
   */
  readonly notChecked?: readonly string[] | undefined;
  /**
   * Where it is going, rendered from the STORED address.
   *
   * A correct total to the wrong address is still a wrong order, and the veto
   * notice is the last point at which the owner can catch it. Null only when the
   * checkout asked for no address at all.
   */
  readonly destination?: string | null | undefined;
}

/**
 * Render money from integer minor units.
 *
 * Throws on a non-integer or negative input rather than rendering something
 * plausible. A total that did not parse cleanly is not a display problem, it is
 * a reason to refuse, and the caller must not be able to paper over it by
 * getting a "0.00" back.
 */
export function formatMinorUnits(amount: MinorUnits, currency: CurrencyCode): string {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new RangeError(`Refusing to render a non-integer or negative amount: ${String(amount)}`);
  }
  const exponent = minorUnitExponent(currency);
  const divisor = 10 ** exponent;
  const major = Math.floor(amount / divisor);
  const digits = exponent === 0 ? amount.toLocaleString('en-US') : `${major.toLocaleString('en-US')}.${String(amount % divisor).padStart(exponent, '0')}`;
  // The currency's own symbol where it has one that names it alone ($38.40, €12.00, £5.00), else its code (CHF 12.00).
  const symbol = currencySymbol(currency);
  return symbol ? `${symbol}${digits}` : `${currency} ${digits}`;
}

const symbols = new Map<string, string | null>();

/** The symbol `en-US` writes for a currency when it differs from the code ("$", "€", "CA$"); null otherwise. Computed once per currency. */
function currencySymbol(currency: string): string | null {
  let symbol = symbols.get(currency);
  if (symbol === undefined) {
    try {
      const part = new Intl.NumberFormat('en-US', { style: 'currency', currency, currencyDisplay: 'symbol' }).formatToParts(0).find((p) => p.type === 'currency')?.value;
      symbol = part && part !== currency ? part : null;
    } catch {
      symbol = null;
    }
    symbols.set(currency, symbol);
  }
  return symbol;
}

/**
 * The approval prompt, ABOVE budget, silence DENIES.
 *
 * States the silence rule in the message. The owner should never have to remember
 * which kind of window they are looking at, and the two say opposite things.
 */
export function renderApprovalMessage(facts: PurchaseFacts, expiresInMinutes: number): string {
  const reasons: Readonly<Record<PurchaseApprovalReason, string>> = {
    'daily-item-budget': 'the item exceeds the remaining daily item budget',
    'per-purchase-ceiling': 'the item exceeds the per-purchase ceiling',
    'requested-maximum': 'the full total exceeds your requested maximum',
    'merchant-recourse': 'this merchant needs your explicit approval',
    'not-checked': 'no decision model is in use, so I did not check everything below',
  };
  const why = [...new Set(facts.approvalReasons ?? [])].map(reason => reasons[reason]).filter(Boolean);
  const notChecked = facts.notChecked ?? [];
  const lines = [
    why.length ? `Approval needed: ${why.join('; ')}.` : 'Approval needed before this purchase.',
    ...(facts.limitReason ? [facts.limitReason] : []),
    ``,
    `  ${renderItem(facts.item)}`,
    `  from ${renderMerchant(facts.merchantDomain)}`,
    ``,
    ...amountLines(facts),
    ``,
    ...(notChecked.length > 0 ? ['Not checked (no decision model is in use); approve only if these are right:', ...notChecked.map(line => `  - ${line}`), ``] : []),
    `  Card ending ${facts.cardLast4}`,
    `  Daily item budget left: ${formatMinorUnits(facts.poolsAfter.item.remaining, facts.currency)}`,
    ``,
    `Reply "approve" to buy it or "deny" to drop it.`,
    `If I hear nothing in ${expiresInMinutes} minutes I will NOT buy it.`,
  ];
  return lines.join('\n');
}

/**
 * The veto prompt, WITHIN budget, silence PROCEEDS.
 *
 * Also states its silence rule, and states it as the opposite of the approval's,
 * because the whole design rests on the owner knowing which one they are holding.
 */
export function renderVetoMessage(facts: PurchaseFacts, expiresInMinutes: number): string {
  const lines = [
    `About to buy this, it is within your budget.`,
    ``,
    `  ${renderItem(facts.item)}`,
    `  from ${renderMerchant(facts.merchantDomain)}`,
    ``,
    ...amountLines(facts),
    ``,
    `  Card ending ${facts.cardLast4}`,
    `  Daily item budget left after this: ${formatMinorUnits(facts.poolsAfter.item.remaining, facts.currency)}`,
    ``,
    `Reply "stop" to cancel, or "go" to buy it now.`,
    `If I hear nothing in ${expiresInMinutes} minutes I WILL buy it.`,
  ];
  return lines.join('\n');
}

function amountLines(facts: PurchaseFacts): string[] {
  const lines = [
    `  Item:     ${formatMinorUnits(facts.itemMinorUnits, facts.currency)}`,
    // The merchant named each reduction, so its label is neutralised like any page text.
    ...(facts.discounts ?? []).map((discount) =>
      `  Discount: -${formatMinorUnits(discount.amountMinorUnits, facts.currency)} (${sanitizeNoticeField(discount.label, 40)})`),
    `  Tax:      ${formatMinorUnits(facts.taxMinorUnits, facts.currency)}`,
  ];
  if (facts.feesMinorUnits > 0) {
    lines.push(`  Fees:     ${formatMinorUnits(facts.feesMinorUnits, facts.currency)}`);
  }
  lines.push(
    `  Shipping: ${formatMinorUnits(facts.shippingMinorUnits, facts.currency)} `
    + `(${sanitizeNoticeField(facts.shippingTier, 20)})`,
  );
  if (facts.stepDown !== null) {
    // Surfaced rather than buried: a step-down needs no approval because it is
    // within budget, but the owner must not learn about it from a late package.
    lines.push(
      `            stepped down from ${facts.stepDown.from} to fit the overage budget, `
      + `saving ${formatMinorUnits(facts.stepDown.savedMinorUnits, facts.currency)}`,
    );
  }
  lines.push(`  TOTAL:    ${formatMinorUnits(facts.totalMinorUnits, facts.currency)}`);
  if (facts.requestedMaximumMinorUnits !== undefined) lines.push(`  Requested maximum: ${formatMinorUnits(facts.requestedMaximumMinorUnits, facts.currency)} (including tax, fees and delivery)`);
  if (facts.destination !== undefined && facts.destination !== null) {
    lines.push(``, `  Ships to: ${facts.destination}`);
  }
  return lines;
}

/**
 * The report after an objection.
 *
 * One word cancels, and then the owner is told what was stopped and the state
 * it was left in, never a silent abandonment that leaves them wondering
 * whether a cart is sitting somewhere half-driven.
 */
export function renderCancellationReport(facts: PurchaseFacts): string {
  return [
    `Stopped. Nothing was charged.`,
    ``,
    `  ${renderItem(facts.item)}`,
    `  from ${renderMerchant(facts.merchantDomain)}`,
    `  would have been ${formatMinorUnits(facts.totalMinorUnits, facts.currency)}`,
    ``,
    `The checkout was abandoned and the budget I was holding is back.`,
  ].join('\n');
}

/**
 * The ONE purchase notice, and the only send site.
 *
 * Design rule: showing the purchase to the owner and alerting them when it is
 * not a major retailer collapse into a single step, since both notify at the
 * same point. So there is one message, sent once, when the item is chosen and the final total is
 * known, before payment. The retailer only changes what SILENCE means.
 *
 * Both branches carry identical content: what was found, the validated
 * registrable domain, the item, and the total re-rendered from our own parsed
 * integers. Never merchant text.
 *
 * This exists so the selection is a branch at one call site rather than an
 * invitation to add a third message type. `renderApprovalMessage` and
 * `renderVetoMessage` stay separate because their SILENCE RULES are opposite and
 * must never be unified, see
 * docs/decisions/2026-07-27-payment-windows-are-deliberately-opposite.md, but
 * callers should reach for this, not for either of them directly.
 */
export function renderPurchaseNotice(input: {
  readonly facts: PurchaseFacts;
  readonly mode: 'approval' | 'veto';
  readonly expiresInMinutes: number;
  /**
   * Why this merchant qualified, or why it did not, from `classifyMerchant`.
   *
   * Always rendered when present, because the verdict alone is not useful to
   * the owner. "Etsy, buyer protection applies" is something they can weigh at a
   * glance; "on your approved list" sends them off to go check a list. On the
   * other side it reads as a checkpoint, not on the list, so I am asking,
   * and never implies anything is wrong with the seller.
   *
   * Sanitised like every other merchant-adjacent string, and prefixed by us so
   * the framing cannot be supplied by anything a page controls.
   */
  readonly merchantReason?: string | undefined;
}): string {
  const body = input.mode === 'approval'
    ? renderApprovalMessage(input.facts, input.expiresInMinutes)
    : renderVetoMessage(input.facts, input.expiresInMinutes);
  if (input.merchantReason === undefined || input.merchantReason.trim().length === 0) return body;
  const label = input.mode === 'veto' ? 'Why I can go ahead' : 'Merchant recourse';
  return `${body}\n\n  ${label}: ${sanitizeNoticeField(input.merchantReason, 240)}`;
}

/**
 * The report after the charge goes through.
 *
 * ══ Why this is not email-driven ══════════════════════════════════════════
 *
 * The daemon knows it charged the card. It does not need a store to tell it,
 * and it must not wait for one: a confirmation can take minutes or hours, some
 * stores send nothing at all, and mail can be broken independently of payments.
 * A report that depended on any of that would leave the owner with a veto notice, ten
 * minutes of silence, a charge, and then nothing.
 *
 * So this fires at the moment the submit is confirmed, from facts this process
 * already holds, and every number in it is re-rendered from our own integers.
 *
 * The shipping tier is reported as the one ACTUALLY used, with the step-down
 * spelled out when there was one. The owner approved a purchase; a delivery
 * option was then chosen inside the budget they set, and they should not learn
 * which from the parcel arriving later than expected.
 */
export function renderPurchaseReport(input: {
  readonly facts: PurchaseFacts;
  /** The merchant's own order reference, when the page showed one. */
  readonly merchantOrderId: string | null;
  /**
   * Whether a composition read the merchant's own response to the submit.
   *
   * False means the click was issued and the card was charged as a
   * conservative default against a double-spend, but nothing here confirmed
   * the merchant actually accepted the order. The headline and the closing
   * line say so plainly rather than reading as a confirmed purchase.
   */
  readonly verified: boolean;
}): string {
  const { facts } = input;
  const lines = [
    input.verified
      ? `Bought it.`
      : `Submitted the order, but I could not confirm it went through.`,
    ``,
    `  ${renderItem(facts.item)}`,
    `  from ${renderMerchant(facts.merchantDomain)}`,
    ``,
    ...amountLines(facts),
    ``,
    `  Paid with the card ending ${sanitizeNoticeField(facts.cardLast4, 8)}`,
  ];
  if (input.merchantOrderId !== null && input.merchantOrderId.trim().length > 0) {
    // The merchant chose this string, so it is neutralised like any other
    // field that came off their page.
    lines.push(`  Their order number: ${sanitizeNoticeField(input.merchantOrderId, 40)}`);
  }
  lines.push(`  Daily item budget left: ${formatMinorUnits(facts.poolsAfter.item.remaining, facts.currency)}`);
  if (!input.verified) {
    lines.push(``, `  I did not read a confirmation from the merchant. Check your order history there.`);
  }
  return lines.join('\n');
}

/**
 * The follow-up once the store's own confirmation turns up.
 *
 * ══ The body is never in here ═════════════════════════════════════════════
 *
 * A confirmation email arrives from outside, at the exact moment the owner is
 * expecting one, which makes it the single most attractive thing for an
 * attacker to forge. Its body is not rendered, not quoted, and not summarised.
 * What reaches the owner is a small set of STRUCTURED fields, an order number, a
 * ship date, a tracking reference, each neutralised, plus our own record of
 * what was bought, which the email cannot influence at all.
 *
 * The email also carries no authority. It cannot confirm that a purchase
 * happened; our ledger already knows that. All it can do is add a reference
 * number to a message the owner was going to get anyway.
 */
/**
 * The ask for the card's security code under `payments.cvvHandling: 'prompt'`,
 * sent to the notice channels once a purchase is approved and reaches payment.
 * It says where to type the code, and never asks for it in the chat itself.
 */
export function renderSecurityCodeRequest(facts: Pick<PurchaseFacts, 'item' | 'merchantDomain' | 'totalMinorUnits' | 'currency' | 'cardLast4'>, expiresInMinutes: number): string {
  return [
    `Ready to pay, waiting for the card security code.`,
    ``,
    `  ${renderItem(facts.item)}`,
    `  from ${renderMerchant(facts.merchantDomain)}`,
    `  TOTAL: ${formatMinorUnits(facts.totalMinorUnits, facts.currency)}, card ending ${sanitizeNoticeField(facts.cardLast4, 8)}`,
    ``,
    `Type the code in the terminal app with /payments pending, or in the local web UI. Do not send it in this chat.`,
    `If it is not typed in ${expiresInMinutes} minutes I will NOT buy it.`,
  ].join('\n');
}

/**
 * The note when a shop's mail says a purchase was refunded. Built from our own
 * record, never the mail's text; the refund is recorded on the purchase and
 * credits no budget pool.
 */
export function renderRefundReport(input: {
  readonly facts: Pick<PurchaseFacts, 'item' | 'totalMinorUnits' | 'currency' | 'cardLast4'>;
  readonly senderDomain: string;
}): string {
  return [
    `${renderMerchant(input.senderDomain)} says this order was refunded.`,
    ``,
    `  ${renderItem(input.facts.item)}`,
    `  ${formatMinorUnits(input.facts.totalMinorUnits, input.facts.currency)} on the card ending `
      + `${sanitizeNoticeField(input.facts.cardLast4, 8)}`,
    ``,
    `I recorded the refund on the purchase. Check your card statement for the credit; a refund does not add back to any budget.`,
  ].join('\n');
}

/**
 * What a merchant's mail about a purchase reports: the order was confirmed,
 * it shipped, or it was delivered. Each is reported to the owner once per purchase.
 */
export const ORDER_MAIL_KINDS = ['confirmed', 'shipped', 'delivered'] as const;
export type OrderMailKind = typeof ORDER_MAIL_KINDS[number];

const ORDER_MAIL_OPENING: Readonly<Record<OrderMailKind, string>> = {
  confirmed: 'confirmed the order.',
  shipped: 'shipped the order.',
  delivered: 'says the order was delivered.',
};

export function renderConfirmationReport(input: {
  /** Only what the report prints; a stored purchase row carries all four. */
  readonly facts: Pick<PurchaseFacts, 'item' | 'totalMinorUnits' | 'currency' | 'cardLast4'>;
  readonly confirmation: {
    readonly orderNumber: string | null;
    readonly shipDate: string | null;
    readonly trackingReference: string | null;
  };
  /** The registrable domain the mail actually came from, computed by us. */
  readonly senderDomain: string;
  /** Absent reads as `confirmed`. */
  readonly kind?: OrderMailKind | undefined;
  /** This mail moved a purchase recorded as unverified to purchased. */
  readonly settled?: boolean | undefined;
}): string {
  const kind = input.kind ?? 'confirmed';
  const lines = [
    `${renderMerchant(input.senderDomain)} ${ORDER_MAIL_OPENING[kind]}`,
    ``,
    `  ${renderItem(input.facts.item)}`,
    `  ${formatMinorUnits(input.facts.totalMinorUnits, input.facts.currency)} charged to the card ending `
      + `${sanitizeNoticeField(input.facts.cardLast4, 8)}`,
  ];
  const { orderNumber, shipDate, trackingReference } = input.confirmation;
  if (orderNumber !== null) lines.push(`  Order number: ${sanitizeNoticeField(orderNumber, 40)}`);
  if (shipDate !== null && kind !== 'delivered') lines.push(`  Ships: ${sanitizeNoticeField(shipDate, 40)}`);
  if (trackingReference !== null) lines.push(`  Tracking: ${sanitizeNoticeField(trackingReference, 60)}`);
  if (input.settled === true) {
    lines.push(``, `The order you approved went through: I could not confirm it when it was submitted, and purchase history now records it as bought.`);
  }
  lines.push(``, `This is the order you approved. The amount above is the one I calculated, not the one the email states.`);
  return lines.join('\n');
}

/**
 * The question sent when no decision model read a shop's mail: which of our
 * purchases it may be about, from OUR records, and what to do. Nothing from
 * the mail itself is quoted; the owner reads the mail in their mailbox.
 */
export function renderUnreadOrderMail(input: {
  readonly senderDomain: string;
  readonly receivedAtMs: number;
  readonly purchases: readonly {
    readonly facts: Pick<PurchaseFacts, 'item' | 'totalMinorUnits' | 'currency' | 'cardLast4'>;
    readonly orderNumber: string | null;
    readonly unverified: boolean;
  }[];
  /** True when the mail carries the order number we recorded for its one purchase. */
  readonly orderNumberMatched: boolean;
}): string {
  const one = input.purchases.length === 1;
  const lines = [
    `A mail from ${renderMerchant(input.senderDomain)} arrived ${new Date(input.receivedAtMs).toISOString().slice(0, 16).replace('T', ' ')} UTC `
      + (input.orderNumberMatched ? 'with the order number of this purchase:' : one ? 'after this purchase; it may be about it:' : 'after these purchases there; it may be about one of them:'),
    ``,
    ...input.purchases.flatMap(({ facts, orderNumber }) => [
      `  ${renderItem(facts.item)}`,
      `  ${formatMinorUnits(facts.totalMinorUnits, facts.currency)} on the card ending ${sanitizeNoticeField(facts.cardLast4, 8)}`
        + (orderNumber === null ? '' : `, order ${sanitizeNoticeField(orderNumber, 40)}`),
    ]),
    ``,
    `No decision model is in use, so I did not read what the mail says (a confirmation, shipping, a cancellation or a refund). Please read it in your mailbox.`,
  ];
  if (input.purchases.some(purchase => purchase.unverified)) {
    lines.push(`A purchase above is recorded as not confirmed: if the mail says it went through, or that it was cancelled, record that in /payments pending.`);
  }
  return lines.join('\n');
}
