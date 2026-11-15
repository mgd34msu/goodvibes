/**
 * checkout-landing.ts, reading the page a submitted checkout landed on.
 *
 * After the one submit click, the merchant shows a confirmation page or an
 * error. This reads that page's own words, in code and with no model request,
 * for two things: that the order was placed, and the order number the shop
 * gave it. Either one makes the submission verified (browser-checkout-driver.ts),
 * so the purchase is recorded as `purchased` with the order number rather than
 * `submitted-unverified`.
 *
 * The reading errs toward "unverified": a page that mentions a decline, a
 * failure or a retry verifies nothing, an order number is taken only beside a
 * confirmation sentence, and a value that is card-shaped (a Luhn-valid 13 to 19
 * digit run) is never taken as an order number. Unverified is the honest
 * default the rest of the flow already reports; a wrong "purchased" is not.
 */
import { sanitizeNoticeField } from '../security/notice-text.js';
import type { CheckoutBrowserEngine, CheckoutEngineTarget, CheckoutSubmission, CheckoutSubmissionDescription } from './browser-checkout-driver.js';

const NOTHING_FOUND: CheckoutSubmissionDescription = Object.freeze({ orderId: null, challenge: null });

const FAILURE = /\b(?:declined|denied|was not (?:accepted|processed|completed|placed)|could not be (?:processed|completed|charged|placed)|unable to (?:process|complete|place)|payment (?:failed|error|was unsuccessful)|transaction failed|please try again|try again later)\b/i;
const CONFIRMED = /\b(?:thank(?:s| you) for (?:your|the) (?:order|purchase)|(?:your )?order (?:is |has been |was )?(?:confirmed|placed|received|complete)|order confirmation|purchase (?:is |has been )?(?:confirmed|complete)|we(?:'|’)ve received your order|your order number)\b/i;
const ORDER_NUMBER = /\b(?:order|confirmation)(?:\s+(?:number|no\.?|id|reference|ref\.?))?\s*(?:is\s*)?[:#]?\s*#?\s*([A-Z0-9][A-Z0-9-]{3,29})\b/gi;

function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = digits.charCodeAt(digits.length - 1 - index) - 48;
    if (index % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}

function cardShaped(token: string): boolean {
  const digits = token.replace(/-/g, '');
  return /^\d{13,19}$/.test(digits) && luhnValid(digits);
}

/**
 * What a landing page's text says about the order. `navigated` is whether the
 * submit moved to a new page; a confirmation sentence on the checkout page
 * itself, without a number, is not taken as confirmation.
 */
export function readOrderConfirmation(text: string, navigated: boolean): CheckoutSubmissionDescription {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0 || FAILURE.test(flat) || !CONFIRMED.test(flat)) return NOTHING_FOUND;
  for (const match of flat.matchAll(ORDER_NUMBER)) {
    const token = match[1] ?? '';
    if (!/\d/.test(token) || cardShaped(token)) continue;
    const orderId = sanitizeNoticeField(token, 30);
    if (orderId.length > 0) return { orderId, challenge: null };
  }
  return navigated ? { orderId: null, challenge: null, confirmed: true } : NOTHING_FOUND;
}

/** The engine reads the landing page needs, beyond what the checkout driver uses. */
export interface CheckoutLandingEngine extends CheckoutBrowserEngine {
  readText: (target: CheckoutEngineTarget, args?: { readonly maxChars?: number | undefined }) => Promise<Record<string, unknown>>;
  snapshot: (target: CheckoutEngineTarget, args?: { readonly limit?: number | undefined }) => Promise<Record<string, unknown>>;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string') return (value as { text: string }).text;
  return '';
}

/**
 * The daemon's `describeSubmission`: one read of the landing page after the
 * submit. The page's body text when it may be read; while the card is still
 * on the page the body is withheld, so the page's headings and control names
 * from a snapshot are read instead. Any failure to read is "nothing found",
 * never a failed submit: the click has already happened.
 *
 * Cost: one page read per purchase.
 */
export function describeCheckoutLanding(
  engineFor: () => Promise<CheckoutLandingEngine>,
): (submission: CheckoutSubmission) => Promise<CheckoutSubmissionDescription> {
  return async (submission) => {
    try {
      const engine = await engineFor();
      let text: string;
      try {
        const read = await engine.readText(submission.target, { maxChars: 20_000 });
        text = `${textOf(read['title'])}\n${textOf(read['content'])}`;
      } catch {
        const snapshot = await engine.snapshot(submission.target, { limit: 400 });
        const elements: readonly unknown[] = Array.isArray(snapshot['elements']) ? snapshot['elements'] as unknown[] : [];
        const names = elements.map((element) => (element && typeof element === 'object' ? textOf((element as { readonly name?: unknown }).name) : ''));
        text = [textOf(snapshot['title']), ...names].join('\n');
      }
      return readOrderConfirmation(text, submission.navigated);
    } catch {
      return NOTHING_FOUND;
    }
  };
}
