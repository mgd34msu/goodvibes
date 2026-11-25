/**
 * checkout-landing.ts, reading the page a submitted checkout landed on.
 *
 * After the one submit click, the merchant shows a confirmation page or an
 * error. This reads that page's own words, in code and with no model request,
 * for what ties it to THIS submit: the order number the shop gave it, or a
 * confirmation that shows the dispatch's own total. The driver turns either
 * into `OrderEvidence` only on the merchant's own domain
 * (browser-checkout-driver.ts), and the purchase is `purchased` only through
 * `settleSubmission` (money.ts). Confirmation wording alone ("Thank you for
 * your order") names no order and proves nothing: it stays `submitted-unverified`.
 *
 * The reading errs toward "unverified": a page that mentions a decline, a
 * failure or a retry verifies nothing, an order number is taken only beside a
 * confirmation sentence, and a value that is card-shaped (a Luhn-valid 13 to 19
 * digit run) is never taken as an order number. Unverified is the honest
 * default the rest of the flow already reports; a wrong "purchased" is not.
 */
import { sanitizeNoticeField } from '../security/notice-text.js';
import { pageShowsAmount, type CheckoutBrowserEngine, type CheckoutEngineTarget, type CheckoutSubmission, type CheckoutSubmissionDescription } from './browser-checkout-driver.js';
import type { Money } from './money.js';

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
 * itself, without a number, is not taken as confirmation. `total` is the
 * dispatch's total: a confirmation without an order number counts
 * (`totalShown`) only when the page shows that very amount.
 */
export function readOrderConfirmation(text: string, navigated: boolean, total?: Money): CheckoutSubmissionDescription {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0 || FAILURE.test(flat) || !CONFIRMED.test(flat)) return NOTHING_FOUND;
  for (const match of flat.matchAll(ORDER_NUMBER)) {
    const token = match[1] ?? '';
    if (!/\d/.test(token) || cardShaped(token)) continue;
    const orderId = sanitizeNoticeField(token, 30);
    if (orderId.length > 0) return { orderId, challenge: null };
  }
  if (!navigated) return NOTHING_FOUND;
  return { orderId: null, challenge: null, confirmed: true, totalShown: total !== undefined && pageShowsAmount(flat, total) };
}

/** The engine reads the landing page needs, beyond what the checkout driver uses. */
export interface CheckoutLandingEngine extends CheckoutBrowserEngine {
  /**
   * The landing page's body text and title with every live card value scrubbed out, read for this code only
   * (browser-engine.ts): the card typed for the order is still registered on the page, so `readText` refuses it.
   */
  readCheckoutLandingText?: ((target: CheckoutEngineTarget, args?: { readonly maxChars?: number | undefined }) => Promise<{ readonly title: string; readonly content: string }>) | undefined;
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
 * submit. The page's body text with the card scrubbed out (the engine's landing
 * read: the card typed for the order stays registered on the page, so the
 * model's text read refuses it); an engine without that read gives its text read,
 * else a snapshot's headings and control names. Any failure to read is "nothing found",
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
        // The page's own words, the card scrubbed out: where the shop prints the order number ("Order number SH-4101"),
        // which a snapshot's headings and control names leave out.
        if (!engine.readCheckoutLandingText) throw new Error('no landing read');
        const read = await engine.readCheckoutLandingText(submission.target, { maxChars: 20_000 });
        text = `${read.title}\n${read.content}`;
      } catch {
        try {
          const read = await engine.readText(submission.target, { maxChars: 20_000 });
          text = `${textOf(read['title'])}\n${textOf(read['content'])}`;
        } catch {
          const snapshot = await engine.snapshot(submission.target, { limit: 400 });
          const elements: readonly unknown[] = Array.isArray(snapshot['elements']) ? snapshot['elements'] as unknown[] : [];
          const names = elements.map((element) => (element && typeof element === 'object' ? textOf((element as { readonly name?: unknown }).name) : ''));
          text = [textOf(snapshot['title']), ...names].join('\n');
        }
      }
      return readOrderConfirmation(text, submission.navigated, submission.dispatch?.total);
    } catch {
      return NOTHING_FOUND;
    }
  };
}
