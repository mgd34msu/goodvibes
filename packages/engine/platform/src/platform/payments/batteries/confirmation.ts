import { assertJudgmentInput } from '../../gate/judgment-input.js';
/**
 * The confirmation-mail readings order-correlation.ts runs:
 *
 * - `engine.payments.order-mail`: which one of the recent purchases at the
 *   mail's shop is this mail about (its confirmation, receipt, shipping or
 *   delivery update), or none. One request per mail whatever the purchase
 *   history, in place of a yes/no per purchase; it replaced the six-hour
 *   CONFIRMATION_WINDOW_MS, which matched any mail from the shop's domain within
 *   six hours, a promotion included, and missed a shipping notice sent the next
 *   day.
 * - `engine.payments.order-number` and `engine.payments.tracking-reference`:
 *   which identifier in the mail is the order number, and which the parcel's
 *   tracking reference, or none. In place of the ORDER_NUMBER and TRACKING
 *   regexes, which took whatever token followed the word "order" or
 *   "tracking" ("Order online at ..." gave "online"; "Tracking will follow"
 *   gave nothing; a tracking number after "Your parcel:" was missed). They are
 *   asked with the same `{ subject, source }` context they are calibrated on;
 *   each candidate carries the text around it, so the body is not sent again.
 * - `engine.payments.ship-date`: the date-parts pattern for when the order
 *   ships or is due, in place of the SHIP_DATE regex. Code assembles the date.
 *
 * The identifier candidates are every token of letters, digits and dashes
 * with at least one digit and three or more characters, listed by code
 * (identifierCandidates) with the text around each; which of them is which is
 * the reading's. The body has card-shaped spans redacted before any reading
 * sees it (order-correlation.ts), so no card number reaches Jev.
 *
 * Bands: medium stakes for the match and the identifiers. A wrong match
 * names the wrong order in a message to the owner, and correlation already
 * refuses to name one when the mail fits two purchases; a wrong identifier is
 * a wrong reference the owner may quote to the shop. Low stakes for the ship
 * date, an informational line in the notice that decides nothing. Only
 * readings that act are used; an identifier whose reading does not act is
 * left out of the report.
 */
import { defineBattery, defineDatePartsReader, defineSelector, NONE, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

/** Most characters of a mail body one request carries; a longer body is read up to here. */
export const MAX_MAIL_CHARS = 160_000;
/** Characters of surrounding text shown with each identifier candidate. */
const CANDIDATE_CONTEXT_CHARS = 60;

/**
 * The part of a mail body a reading takes: the whole body, or its first
 * MAX_MAIL_CHARS characters. `clipped` tells the caller the identifiers may lie
 * beyond what was read.
 */
export function clipMail(text: string): { readonly text: string; readonly clipped: boolean } {
  const clipped = text.length > MAX_MAIL_CHARS;
  const kept = clipped ? text.slice(0, MAX_MAIL_CHARS) : text;
  assertJudgmentInput(kept);
  return { text: kept, clipped };
}

/** The mail and the shop it came from, as the order-mail reading sees them. */
export type OrderMailContext = {
  readonly merchant: string;
  readonly mail: { readonly subject: string; readonly body: string; readonly received_at: string };
};

/** One recorded purchase at that shop, as an order-mail candidate. */
export type OrderMailCandidate = {
  readonly id: string;
  readonly content: { readonly item: string; readonly total: string; readonly placed_at: string; readonly outcome: string };
};

const IDENTIFIER = /[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/g;
const HAS_DIGIT = /\d/;
const MIN_IDENTIFIER_CHARS = 3;

/**
 * Every identifier-shaped token in `text`, first occurrence only, with the
 * text around it. This lists what could be a reference at all (letters,
 * digits and dashes, one digit or more); it decides nothing about which one
 * is which.
 */
export function identifierCandidates(text: string): { id: string; content: { token: string; around: string } }[] {
  const seen = new Set<string>();
  const candidates: { id: string; content: { token: string; around: string } }[] = [];
  for (const match of text.matchAll(IDENTIFIER)) {
    const token = match[0];
    if (token.length < MIN_IDENTIFIER_CHARS || !HAS_DIGIT.test(token) || seen.has(token)) continue;
    seen.add(token);
    const start = match.index ?? 0;
    const around = text.slice(Math.max(0, start - CANDIDATE_CONTEXT_CHARS), start + token.length + CANDIDATE_CONTEXT_CHARS).replace(/\s+/g, ' ').trim();
    candidates.push({ id: `t${candidates.length}`, content: { token, around } });
  }
  return candidates;
}

const mailContext = (subject: string, body: string, received_at: string): OrderMailContext => ({ merchant: 'bestbuy.com', mail: { subject, body, received_at } });
const purchase = (id: string, item: string, total: string, placed_at: string): OrderMailCandidate => ({ id, content: { item, total, placed_at, outcome: 'purchased' } });
const HUB = purchase('p0', 'USB-C hub', '42.78 USD', '2026-03-02T14:05:00Z');
const HEADPHONES = purchase('p1', 'Sony WH-1000XM5 headphones', '348.00 USD', '2026-02-20T10:12:00Z');
const CABLE = purchase('p2', 'HDMI cable 2m', '12.99 USD', '2026-02-27T18:40:00Z');

export const orderMail = defineSelector({
  name: 'engine.payments.order-mail',
  version: 2,
  description: 'Which recorded purchase at a shop an inbound mail from that shop is about, or none.',
  accuracyFloor: 0.85,
  instructions: '`context.mail` arrived from the shop `context.merchant`, where the owner\'s assistant made the purchases in `candidates`, each with its item, total, when it was placed and its outcome. Which one purchase is this mail about: its order confirmation, receipt, payment notice, shipping, dispatch or delivery update, or a problem with it?',
  fitInstructions: 'Is the mail about this candidate purchase: it names this item, this total, or an order placed around this time, and it is not marketing, an account notice, a review request with no order details, or about a different order?',
  band: STAKES_BANDS.medium.confidence,
  fitBand: STAKES_BANDS.medium.yesNo,
  fixtures: [
    { name: 'the confirmation minutes later', context: mailContext('Your Best Buy order has been received', 'Thanks for your order! Order #BBY01-806512334. USB-C hub x1. Order total $42.78.', '2026-03-02T14:07:10Z'), candidates: [HUB, HEADPHONES, CABLE], expect: 'p0' },
    { name: 'a shipping notice the next day', context: mailContext('Your order is on the way', 'Good news: your USB-C hub has shipped. Track it with UPS 1Z999AA10123456784. Estimated delivery Thursday, March 5.', '2026-03-03T09:30:00Z'), candidates: [HUB, CABLE], expect: 'p0' },
    { name: 'a promotion within an hour', context: mailContext('Weekend deals: up to 40% off TVs', 'Shop the biggest TV sale of the season. Offers end Sunday. Unsubscribe anytime.', '2026-03-02T15:00:00Z'), candidates: [HUB, HEADPHONES], expect: NONE },
    { name: 'the older of two orders', context: mailContext('Your order has shipped', 'Your order #BBY01-771122009 (Sony WH-1000XM5 headphones, $348.00, placed February 20) has shipped.', '2026-03-02T16:20:00Z'), candidates: [HUB, HEADPHONES, CABLE], expect: 'p1' },
    { name: 'an order nothing recorded', context: mailContext('Your order has shipped', 'Your order #BBY01-771122009 (Sony WH-1000XM5 headphones, $348.00, placed February 20) has shipped.', '2026-03-02T16:20:00Z'), candidates: [HUB, CABLE], expect: NONE },
    { name: 'an account notice', context: mailContext('Your password was changed', 'The password on your Best Buy account was changed. If this was not you, contact us.', '2026-03-02T14:30:00Z'), candidates: [HUB], expect: NONE },
  ],
});

const CONFIRMATION = 'Thanks for shopping with us! Order number: W1234-88812. Placed Mar 2, 2026. Items: USB-C hub x1 $34.99. Subtotal $34.99, shipping $4.99, tax $2.80, total $42.78. Call 1-800-433-7200 with questions.';
const SHIPPED = 'Your package is on its way. Carrier: UPS. Your parcel: 1Z999AA10123456784. Order W1234-88812 shipped March 3 and should arrive by March 6. Store #1123, 7601 Penn Ave S.';
const PENDING = 'We received your order 55-20931-3301 and will email tracking details when it ships. Questions? Call 800-555-0142.';
const PROMO = 'Order online at store.example.com and save 15% with code SPRING24 through April 30.';

/** The context the identifier selectors are asked and calibrated with. */
export const identifierContext = (subject: string): { readonly subject: string; readonly source: string } => ({ subject, source: 'a shop\'s mail about an order' });

export const orderNumber = defineSelector({
  name: 'engine.payments.order-number',
  version: 1,
  description: 'Which identifier in a shop\'s mail is the order number, or none.',
  accuracyFloor: 0.85,
  instructions: '`candidates` are the identifier-shaped tokens found in a shop\'s mail, each with the text `around` it. Which one is the shop\'s order number (also called order ID or confirmation number) for the order the mail is about?',
  fitInstructions: 'Is this candidate\'s `token` the order number, order ID or confirmation number of the order, rather than a phone number, a price, a date, a store number, a promotion code or a tracking number?',
  band: STAKES_BANDS.medium.confidence,
  fitBand: STAKES_BANDS.medium.yesNo,
  fixtures: [
    { name: 'an order number beside a phone number and prices', context: identifierContext('Order confirmation'), candidates: identifierCandidates(CONFIRMATION), expect: 't0' },
    { name: 'an order number in a shipping notice', context: identifierContext('Your order has shipped'), candidates: identifierCandidates(SHIPPED), expect: 't1' },
    { name: 'a dashed order id', context: identifierContext('Order received'), candidates: identifierCandidates(PENDING), expect: 't0' },
    { name: 'a promotion with no order', context: identifierContext('Spring sale'), candidates: identifierCandidates(PROMO), expect: NONE },
  ],
});

export const trackingReference = defineSelector({
  name: 'engine.payments.tracking-reference',
  version: 1,
  description: 'Which identifier in a shop\'s mail is the parcel\'s tracking reference, or none.',
  accuracyFloor: 0.85,
  instructions: '`candidates` are the identifier-shaped tokens found in a shop\'s mail, each with the text `around` it. Which one is the carrier tracking number for the parcel?',
  fitInstructions: 'Is this candidate\'s `token` a carrier tracking number for the parcel, rather than an order number, a phone number, a store number, a date or a price?',
  band: STAKES_BANDS.medium.confidence,
  fitBand: STAKES_BANDS.medium.yesNo,
  fixtures: [
    { name: 'a UPS number after "Your parcel:"', context: identifierContext('Your order has shipped'), candidates: identifierCandidates(SHIPPED), expect: 't0' },
    { name: 'tracking promised later', context: identifierContext('Order received'), candidates: identifierCandidates(PENDING), expect: NONE },
    { name: 'a confirmation with no parcel yet', context: identifierContext('Order confirmation'), candidates: identifierCandidates(CONFIRMATION), expect: NONE },
  ],
});

/** The mail and the purchase it was matched to, as the refund reading sees them. */
export type RefundMailView = {
  readonly mail: { readonly subject: string; readonly body: string };
  readonly purchase: { readonly item: string; readonly total: string };
};

const refundView = (subject: string, body: string): RefundMailView => ({ mail: { subject, body }, purchase: { item: 'USB-C hub', total: '42.78 USD' } });

/**
 * `engine.payments.refund-mail`: asked only of a mail already matched to one
 * purchase, so one reading per matched mail. A yes records `refundedAt` on the
 * purchase; a refund credits no budget pool.
 */
export const refundMail = defineBattery({
  name: 'engine.payments.refund-mail',
  version: 1,
  description: 'Whether a shop\'s mail about one recorded purchase says that purchase was refunded.',
  accuracyFloor: 0.85,
  items: {
    refunded: yesNo(
      '`mail` is from the shop about the purchase in `purchase`. Does it say money for this purchase has been or is being refunded to the buyer: a refund issued, a return credited, or the order cancelled with the charge reversed?',
      STAKES_BANDS.medium.yesNo,
      {
        true: 'The mail says this purchase was refunded, credited back or cancelled with the charge reversed.',
        false: 'The mail confirms, ships or delivers the order, asks for a review, or only describes how to request a return.',
      },
    ),
  },
  fixtures: [
    { name: 'a refund issued', state: refundView('Your refund has been processed', 'We have refunded $42.78 for your USB-C hub to the card you used. It may take 5-7 days to appear.'), expect: { refunded: 'yes' } },
    { name: 'a cancelled order with the charge reversed', state: refundView('Your order was cancelled', 'Your order for the USB-C hub was cancelled because the item is out of stock. The charge of $42.78 has been reversed.'), expect: { refunded: 'yes' } },
    { name: 'a confirmation', state: refundView('Thanks for your order', 'Order #BBY01-806512334. USB-C hub x1. Order total $42.78.'), expect: { refunded: 'no' } },
    { name: 'return instructions only', state: refundView('Your order was delivered', 'Your USB-C hub was delivered. Not happy? You can return it within 30 days for a full refund.'), expect: { refunded: 'no' } },
  ],
});

/** The date the ship-date reading asks for. */
export const SHIP_DATE_ROLE = 'the date the order is expected to be delivered, or the date it ships when the mail gives no delivery date';

export const shipDate = defineDatePartsReader({
  name: 'engine.payments.ship-date',
  version: 1,
  description: 'When a shop\'s mail says the order ships or is due, as its date parts.',
  accuracyFloor: 0.85,
  band: STAKES_BANDS.low.confidence,
  fixtures: [
    { name: 'arrives by a named date', document: SHIPPED, role: SHIP_DATE_ROLE, today: '2026-03-03', expect: '2026-03-06' },
    { name: 'estimated delivery with a weekday', document: 'Estimated delivery: Thursday, March 5. Thanks for your order.', role: SHIP_DATE_ROLE, today: '2026-03-02', expect: '2026-03-05' },
    { name: 'arriving tomorrow', document: 'Great news, your order is arriving tomorrow between 10am and 2pm.', role: SHIP_DATE_ROLE, today: '2026-03-04', expect: '2026-03-05' },
    { name: 'no date stated', document: PENDING, role: SHIP_DATE_ROLE, today: '2026-03-02', expect: NONE },
  ],
});
