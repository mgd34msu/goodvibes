import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';
/**
 * browser-checkout-driver.ts, the page driver a real browser can answer.
 *
 * ══ The gap this closes ═══════════════════════════════════════════════════
 *
 * `CheckoutPageDriver` (checkout-page.ts) is the port the whole purchase runs
 * against, and until now the only implementation of it was a test fixture. A
 * daemon that had a browser open could not begin a checkout on it, because
 * nothing turned an open page into one of these. `payments.checkout.begin`
 * was a cataloged verb with no implementation behind it for exactly that
 * reason.
 *
 * ══ Why the adapter lives here and not in platform/browser ════════════════
 *
 * card-material.ts states that one module produces card material and
 * browser-secret-fill.ts states that one module types it. This file is neither:
 * it receives values fill-card.ts already read and hands them to the engine's
 * `fillSecretBatch`, which is the single typing path. Putting it on the
 * payments side keeps `platform/browser/` free of payment wiring, which is the
 * property browser-secret-fill.ts was split out to preserve.
 *
 * It also does not IMPORT the browser engine. `CheckoutBrowserEngine` below is
 * a structural description of the engine operations a purchase needs, and
 * `BrowserEngine` satisfies it without knowing this file exists. That keeps
 * `platform/payments/` importing nothing from `platform/browser/`, and it is
 * what lets the tests drive every path against a scripted fake with no driver,
 * no display and no process. It is also why a pre-click vs post-click submit
 * failure is told apart by the THROWN ERROR'S NAME rather than by importing
 * `StaleElementError`/`UntrustedEffectError`/`BrowserSessionError`: those
 * names are the engine's own public contract (the containment tests already
 * assert on them), and matching on a string keeps this file free of an import
 * those three classes would otherwise force.
 *
 * ══ The guard is checked, not assumed ═════════════════════════════════════
 *
 * `PaymentsGatewayServiceImpl` arms a `CardMaterialRedactor` before the first
 * keystroke, and the engine scrubs page output against the guard it was BUILT
 * with. Those have to be one object. Two instances means the flow arming one
 * while the engine scrubs against the other, which looks correct at every call
 * site and leaves the card readable in the next snapshot.
 *
 * So this adapter refuses rather than degrades, on two independent checks:
 *
 *  1. **Identity.** Every operation resolves the engine and compares
 *     `engine.cardFieldGuard()` against the guard this driver was constructed
 *     with. Null refuses (no redaction installed at all); a different object
 *     refuses (the engine is scrubbing against something else).
 *  2. **Armed.** Before typing card material, the guard must already hold live
 *     material for this exact page. fill-card.ts arms before it fills, so a
 *     guard that is not armed here is not the object the flow armed, whatever
 *     check 1 said about the engine. This one catches the mismatch that matters
 *     most, a payments service holding a redactor nobody handed to the engine.
 *
 * Neither check is advisory and neither can be skipped by a call site: they run
 * inside the accessor every method goes through.
 *
 * ══ What this driver deliberately cannot tell you ═════════════════════════
 *
 * `submitOrder` reports the url it landed on and, without help, nothing else.
 * Reading a merchant order number off a confirmation page, or recognising a
 * 3-D Secure interstitial, is page knowledge, and checkout-page.ts keeps it
 * out of this port. The daemon's composition supplies `describeSubmission`
 * (checkout-landing.ts reads the landing page for a confirmation and its order
 * number); a composition without one, or a landing page that shows neither,
 * gets a null order id AND `verified: false`, which checkout-flow.ts records
 * and reports honestly as submitted-but-unconfirmed rather than as a purchase
 * nothing here actually watched complete.
 *
 * ══ What actually clears the outward-effect guard today ═══════════════════
 *
 * The engine refuses to activate a submitting control once the turn has read
 * page content THIS turn (security/untrusted-content.ts,
 * `evaluateOutwardEffect`). A purchase always reads a snapshot to find the refs
 * it passes in, but that read normally happened on an EARLIER turn: the model
 * snapshots a checkout, decides to buy, and the daemon then runs
 * `payments.checkout.begin` as a fresh owner-direct call, which resets the
 * untrusted-content ledger's turn watermark (`startTurnForOwnerRequest`,
 * security/turn-boundary.ts) before this flow does anything. Nothing this
 * flow itself does calls `snapshot`/`readText`/`extract`, so the watermark
 * reset is usually what leaves `taintOriginsThisTurn()` empty at the moment of the
 * click, and an empty set clears the guard with no `OwnerApproval` involved at
 * all. This is a fact about how the verb is normally invoked, not a property
 * this driver enforces, and it stops holding the moment something reads page
 * content inside the SAME turn as the submit.
 *
 * For that case, and as the honest, deliberate fallback, `BrowserCheckoutSeam`
 * (routes/browser-composition.ts) exposes `armSubmitApproval`, a
 * composition-only path onto the engine's `setOwnerApproval`. It is minted
 * and called by the daemon composition, never by anything in
 * `platform/payments/`: only the product's trust contract can construct an
 * `OwnerApproval`, and a payments module that could mint one would be a
 * payments module that could authorise its own spending. What this adapter
 * guarantees on its own side is that a refused submit is a refused submit: it
 * never retries, and it tells a pre-click refusal (`CheckoutSubmitRefused`)
 * apart from genuine post-click ambiguity so the flow's journal and its held
 * budget reservation reflect which one actually happened.
 */
import type { CardFieldKind } from './card-redaction.js';
import { captureCheckoutOwnership, type CheckoutOperationOwnership } from './checkout-ownership.js';
import { CheckoutQuoteChanged, CheckoutSubmitRefused, type CheckoutChallenge, type CheckoutPageDriver, type CheckoutTerms, type PageIdentity } from './checkout-page.js';
import { captureOwnedJson, JudgmentInputError } from '../gate/judgment-input.js';
import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { checkAnswers, toJson, type EntryType, type JudgmentPort } from '@goodvibes-jev/judgment';
import { checkoutTerms, checkoutTermsView } from './batteries/checkout-terms.js';
import { registrableDomain } from '../security/public-suffix.js';
import type { RawCheckoutReading } from './checkout-extraction.js';
import type { MarketplaceListing } from './marketplace-listing.js';
import { readRepricedCheckout, readRepricedCheckoutInCode } from './checkout-repricing.js';
import { markPaymentCheckoutAction } from '../security/order-submission.js';
import { decisionOrClassic } from '../runtime/decision-policy.js';
import { minorUnitExponent } from './money-parsing.js';
import type { Money, OrderEvidence, SubmissionDispatch } from './money.js';

/** An amount in minor units as a page may print it: with or without grouping, with a point or a comma before the minor digits. */
function printedAmounts(amount: number, currency: string): string[] {
  const exponent = minorUnitExponent(currency);
  const major = Math.floor(amount / 10 ** exponent);
  const minor = exponent === 0 ? '' : String(amount % 10 ** exponent).padStart(exponent, '0');
  const plain = String(major), comma = major.toLocaleString('en-US'), dot = comma.replaceAll(',', '.'), space = comma.replaceAll(',', ' ');
  if (exponent === 0) return [...new Set([plain, comma, dot, space])];
  return [...new Set([`${plain}.${minor}`, `${comma}.${minor}`, `${plain},${minor}`, `${dot},${minor}`, `${space},${minor}`])];
}

/** Whether `text` prints `value` in any of the ways a page prints an amount, as a whole number. */
export function pageShowsAmount(text: string, value: Money): boolean {
  return printedAmounts(value.minor, value.currency).some(amount => holdsAmount(text, amount));
}

/** Whether `text` holds `amount` as a whole number, not inside a longer one. */
function holdsAmount(text: string, amount: string): boolean {
  for (let at = text.indexOf(amount); at !== -1; at = text.indexOf(amount, at + 1)) {
    const before = text.slice(Math.max(0, at - 2), at), after = text.slice(at + amount.length, at + amount.length + 2);
    if (!/\d$|\d[.,]$/.test(before) && !/^\d|^[.,]\d/.test(after)) return true;
  }
  return false;
}

/** A line of the order summary that states the payable total ("Total", "Order total", "Grand total"), never a subtotal. */
const TOTAL_LABEL = /\b(?:order |grand |estimated |)total\b/i;
const NOT_THE_TOTAL = /\bsub-?\s?total\b|\btotal (?:savings|discount|items?)\b/i;

/**
 * The amounts the order summary states as its total: each line labelled as
 * the total (not a subtotal), and when the label stands alone on its line, the
 * line after it (a label and its amount in two cells).
 */
function statedTotalLines(text: string): readonly string[] {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const stated: string[] = [];
  lines.forEach((line, index) => {
    if (!TOTAL_LABEL.test(line) || NOT_THE_TOTAL.test(line)) return;
    stated.push(line);
    if (!/\d/.test(line) && lines[index + 1] !== undefined) stated.push(lines[index + 1]!);
  });
  return stated;
}

/**
 * Code's terms check when no decision model reads the live checkout. The
 * approved payable total must be the amount the order summary's total line
 * states, not merely a number printed somewhere on the page (a cart line, a
 * free-shipping threshold or an advert can print it too). The delivery option
 * the quote chose must be one the page shows as selected (a chosen <select>
 * option, a checked radio or an ARIA-selected control); a page that offers no
 * selectable option at all is held to its total line alone, since the total
 * already carries the delivery cost. A page without a total line, or with
 * selectable options none of which names the chosen one, is not verified: the
 * purchase stops and the owner is asked again. The page origin and submit
 * control were already checked by `observePage`.
 */
function pageShowsApprovedTerms(expected: CheckoutTerms, state: object): boolean {
  const documents = (state as { readonly documents?: unknown }).documents;
  if (!Array.isArray(documents) || documents.length === 0) return false;
  const totals: string[] = [];
  const selected: string[] = [];
  for (const document of documents) {
    const view = document as {
      readonly checkout?: { readonly text?: unknown; readonly selections?: unknown };
      readonly controls?: unknown;
    } | null;
    const checkout = view?.checkout;
    if (typeof checkout?.text !== 'string') return false;
    totals.push(...statedTotalLines(checkout.text));
    if (Array.isArray(checkout.selections)) for (const selection of checkout.selections as { readonly labels?: unknown }[]) {
      if (Array.isArray(selection?.labels)) selected.push(...selection.labels.filter((label): label is string => typeof label === 'string'));
    }
    if (Array.isArray(view?.controls)) for (const control of view.controls as { readonly checked?: unknown; readonly name?: unknown; readonly control?: { readonly type?: unknown; readonly label?: unknown } }[]) {
      if (control?.checked !== true || control.control?.type !== 'radio') continue;
      for (const name of [control.name, control.control.label]) if (typeof name === 'string' && name.trim()) selected.push(name);
    }
  }
  const amounts = printedAmounts(expected.total.minor, expected.total.currency);
  if (!totals.some(line => amounts.some(amount => holdsAmount(line, amount)))) return false;
  const shipping = expected.shippingLabel.trim().toLowerCase();
  if (shipping.length === 0 || selected.length === 0) return true;
  return selected.some(label => label.toLowerCase().includes(shipping));
}

/**
 * The part of a card-material guard this adapter can see.
 *
 * Both `CardMaterialRedactor` (payments) and `CardFieldGuard` (browser) satisfy
 * it, which is the point: the identity check compares two references the two
 * layers each describe in their own terms.
 */
export interface CheckoutGuardHandle {
  hasLiveMaterial(sessionId: string, pageId: string): boolean;
}

/** Which session and page an engine operation acts on. */
export interface CheckoutEngineTarget {
  readonly sessionId?: string | undefined;
  readonly pageId?: string | undefined;
}

/** Additional restrictions for a host-restored native page. This binding
 * grants nothing: the caller must still supply current payment authority. */
export interface CheckoutDriverRecoveryBinding {
  readonly snapshotId: string;
  readonly assertCurrent: () => void;
  readonly signal?: AbortSignal | undefined;
}
interface CheckoutControlOwnership {
  readonly assertCurrent: () => void;
  readonly signal?: AbortSignal | undefined;
  readonly snapshotId?: string | undefined;
}

/**
 * The engine operations a purchase needs, described structurally so that
 * `BrowserEngine` satisfies this without either module importing the other.
 *
 * Every one of them answers with the engine's open record. This adapter reads
 * only `url`/`filled`/`failedRef` out of those records and never forwards a
 * whole one, so nothing a page wrote reaches the checkout flow through here.
 *
 * Every member is written in PROPERTY position (`foo: (args) => Ret`), not
 * method-shorthand (`foo(args): Ret`). TypeScript checks method-shorthand
 * parameters bivariantly even under `strictFunctionTypes`, so a real engine
 * method whose parameter type quietly narrowed or widened would still satisfy
 * this interface with no compile error. Property position is checked
 * contravariantly, which is what makes a real signature drift here a build
 * failure instead of a silent one.
 */
export interface CheckoutBrowserEngine {
  cardFieldGuard: () => CheckoutGuardHandle | null;
  tabs: (target: CheckoutEngineTarget) => Promise<Record<string, unknown>>;
  type: (target: CheckoutEngineTarget, args: { readonly ref: string; readonly text: string }, ownership?: CheckoutControlOwnership) => Promise<Record<string, unknown>>;
  fillSecretBatch: (
    target: CheckoutEngineTarget,
    args: { readonly fills: readonly { readonly ref: string; readonly value: string; readonly kind?: CardFieldKind | undefined }[] },
    ownership?: CheckoutControlOwnership,
  ) => Promise<Record<string, unknown>>;
  select: (target: CheckoutEngineTarget, args: { readonly ref: string; readonly values: readonly string[] }, ownership?: CheckoutControlOwnership) => Promise<Record<string, unknown>>;
  click: (target: CheckoutEngineTarget, args: { readonly ref: string }, ownership?: {
    readonly assertCurrent: () => void; readonly signal?: AbortSignal | undefined; readonly snapshotId?: string | undefined; readonly beforeDispatch?: (() => Promise<void>) | undefined;
  }) => Promise<Record<string, unknown>>;
  observeCheckoutTerms?: (target: CheckoutEngineTarget, ownership: CheckoutControlOwnership, submitTarget?: string) => Promise<{
    readonly state: object; readonly assertCurrent: () => Promise<void>; readonly signal?: AbortSignal | undefined;
  }>;
  readMarketplaceListing?: (target: CheckoutEngineTarget, ownership?: CheckoutControlOwnership) => Promise<{
    readonly url: string; readonly format: MarketplaceListing['format'];
    readonly sellerFeedbackCount: number | null; readonly sellerPositivePercent: number | null;
    readonly fromPlatformWidget: boolean; readonly sellerName: string | null;
  }>;
}

/** What the driver landed on after the one outward act, before it is described. */
export interface CheckoutSubmission {
  readonly url: string;
  readonly navigated: boolean;
  /** The page the submit was clicked on, for a composition that reads where it landed. */
  readonly target: CheckoutEngineTarget;
  /** The submit this click was, when the flow named one: its total is what a confirmation must show. */
  readonly dispatch?: SubmissionDispatch | undefined;
}

/**
 * A merchant-order reading, when the composition has one.
 *
 * `verified` on the submission this produces is evidence-based: it is true
 * only when this description carries something the composition actually
 * looked at and found, an order id, a challenge, or `confirmed: true`. A
 * composition that ran and saw nothing, a declined card, a spinner, a page it
 * did not recognise, returns all three empty/false/null, and the submission is
 * `verified: false` exactly as if `describeSubmission` had never been wired.
 * Being CALLED is not evidence; what it returns is.
 */
export interface CheckoutSubmissionDescription {
  readonly orderId: string | null;
  readonly challenge: CheckoutChallenge | null;
  /**
   * Set when the composition positively confirmed the order without a
   * merchant order number to point to, a "thank you" / order-confirmed marker
   * it recognised on the landing page. Absent or false is not evidence of
   * anything, it is simply the common case where nothing more specific was
   * found.
   */
  readonly confirmed?: boolean | undefined;
  /** With `confirmed`: the landing page shows the dispatch's own total. */
  readonly totalShown?: boolean | undefined;
}

export interface BrowserCheckoutDriverDeps {
  /**
   * The engine, resolved on first use.
   *
   * A function rather than an instance because the daemon builds its browser
   * lazily: registering the verbs must not download a driver or start a
   * process, so the driver factory has to exist before the engine does.
   */
  readonly engineFor: () => Promise<CheckoutBrowserEngine>;
  /**
   * The guard the payments service arms. Must be the same object the engine was
   * constructed with; see the two checks in this module's header.
   */
  readonly cardFieldGuard: CheckoutGuardHandle;
  /** Reads a merchant order id or a verification step off the landing page. */
  readonly describeSubmission?:
    | ((submission: CheckoutSubmission) => Promise<CheckoutSubmissionDescription>)
    | undefined;
}

/**
 * A refusal from the driver itself, as opposed to a page that would not accept
 * input.
 *
 * Carries no card material: every message below names a field, a page or a
 * missing guard, and never a value. The `fix` is what the operator has to
 * change in the composition, because every one of these is a wiring fault
 * rather than something a retry would clear.
 */
export class CheckoutDriverRefusal extends Error {
  constructor(message: string, readonly fix: string) {
    super(message);
    this.name = 'CheckoutDriverRefusal';
  }
}

function readUrl(result: Record<string, unknown>): string | null {
  const url = result['url'];
  return typeof url === 'string' && url.length > 0 ? url : null;
}

/**
 * A `CheckoutPageDriver` over one open page of a browser engine.
 *
 * Bound to a session and a page at construction and never resolving a default:
 * a purchase decided against one page must not be typed into whichever page
 * happens to be active when the second verb arrives.
 */
class BrowserCheckoutPageDriver implements CheckoutPageDriver {
  private readonly target: CheckoutEngineTarget;
  #termsOwner: object | null = null;
  #quote: { readonly engine: CheckoutBrowserEngine; readonly submitTarget: string; readonly current: () => Promise<void> } | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly pageId: string,
    private readonly deps: BrowserCheckoutDriverDeps,
    private readonly recovery?: CheckoutDriverRecoveryBinding,
  ) {
    this.target = Object.freeze({ sessionId, pageId });
    this.deps = Object.freeze({ ...deps });
    this.recovery = recovery && Object.freeze({ snapshotId: recovery.snapshotId, signal: recovery.signal, assertCurrent: recovery.assertCurrent.bind(recovery) });
  }

  private ownership(options?: CheckoutOperationOwnership): CheckoutControlOwnership {
    const original = captureCheckoutOwnership(options), recovery = this.recovery;
    const signal = original.signal && recovery?.signal ? AbortSignal.any([original.signal, recovery.signal]) : original.signal ?? recovery?.signal;
    const owner = captureCheckoutOwnership({ signal, assertCurrent: () => {
      original.assertCurrent(); recovery?.assertCurrent(); original.assertCurrent();
    } });
    return Object.freeze({ ...owner, snapshotId: recovery?.snapshotId });
  }

  identity(): PageIdentity {
    return { sessionId: this.sessionId, pageId: this.pageId };
  }

  /**
   * The listing as the marketplace page states it: format from its purchase
   * controls, seller figures from its seller widget (never the seller's own
   * text). Undefined when this browser cannot read it or the page is not on
   * https.
   */
  async readListing(ownership: { readonly assertCurrent: () => void; readonly signal?: AbortSignal | undefined }): Promise<MarketplaceListing | undefined> {
    const owner = this.ownership(ownership);
    const engine = await this.engine(); owner.assertCurrent();
    const read = engine.readMarketplaceListing;
    if (typeof read !== 'function') return undefined;
    const facts = await read.call(engine, this.target, owner); owner.assertCurrent();
    let secure = false;
    try { secure = new URL(facts.url).protocol === 'https:'; } catch { secure = false; }
    if (!secure) return undefined;
    return {
      format: facts.format,
      reputation: {
        sellerFeedbackCount: facts.sellerFeedbackCount,
        sellerPositivePercent: facts.sellerPositivePercent,
        region: facts.fromPlatformWidget ? 'platform-widget' : 'unknown',
      },
      ...(facts.sellerName ? { sellerIdentity: facts.sellerName } : {}),
    };
  }

  private invalidateTerms(): void { this.#termsOwner = null; this.#quote = null; }

  /**
   * One observation of the live checkout and the code-only facts about it: the
   * page is on the merchant's registrable domain over https and the submit
   * control is the one the quote named. Null when either fact fails. No model
   * is asked here.
   */
  private async observePage(expected: CheckoutTerms, ownership: { readonly assertCurrent: () => void; readonly signal?: AbortSignal | undefined }) {
    this.#quote = null;
    const token = {};
    this.#termsOwner = token;
    const retained = captureOwnedJson(expected) as unknown as CheckoutTerms;
    const owner = this.ownership(ownership);
    const engine = await this.engine(); owner.assertCurrent();
    const observe = engine.observeCheckoutTerms;
    if (typeof observe !== 'function') throw new CheckoutDriverRefusal('Fresh checkout terms cannot be read by this browser.', 'Use the current browser checkout seam.');
    const observation = await observe.call(engine, this.target, { ...owner, snapshotId: this.recovery?.snapshotId }, retained.submitTarget); owner.assertCurrent();
    const assertObservation = observation.assertCurrent;
    const observationSignal = observation.signal;
    const signal = observationSignal && owner.signal ? AbortSignal.any([observationSignal, owner.signal]) : observationSignal ?? owner.signal;
    if (typeof assertObservation !== 'function') throw new CheckoutDriverRefusal('The current checkout observation is incomplete.', 'Read the checkout again.');
    const state = captureOwnedJson(observation.state);
    if (!state || typeof state !== 'object' || Array.isArray(state) || !('url' in state) || typeof state.url !== 'string') throw new CheckoutDriverRefusal('The current checkout page has no verifiable origin.', 'Read the checkout again.');
    if (!('submitControl' in state) || !state.submitControl || typeof state.submitControl !== 'object' || Array.isArray(state.submitControl)
      || !('ref' in state.submitControl) || state.submitControl.ref !== retained.submitTarget) return null;
    let url: URL;
    try { url = new URL(state.url); } catch { return null; }
    if (url.protocol !== 'https:' || url.username || url.password || registrableDomain(url.hostname) !== retained.merchantDomain) return null;
    const assertActive = (): void => {
      owner.assertCurrent();
      signal?.throwIfAborted();
      if (this.#termsOwner !== token || engine.observeCheckoutTerms !== observe || observation.assertCurrent !== assertObservation || observation.signal !== observationSignal) throw new CheckoutDriverRefusal('The original checkout observation was replaced.', 'Read the checkout again.');
    };
    /** Re-reads the observed page; run once after a reading and once immediately before dispatch. */
    const current = async (): Promise<void> => {
      assertActive();
      await assertObservation.call(observation); assertActive();
    };
    return { retained, engine, state, signal, current, assertActive, ownership: owner };
  }

  /** The observation with a judgment port whose every attempt is bound to it by synchronous checks. */
  private async observeTerms(expected: CheckoutTerms, ownership: { readonly assertCurrent: () => void; readonly signal?: AbortSignal | undefined }) {
    const observed = await this.observePage(expected, ownership);
    if (!observed) return null;
    const { assertActive } = observed;
    const base = captureJudgmentPort('payments.current-checkout-terms', observed.ownership).port;
    // The page itself is re-read once, after the answer (verifyTerms); every
    // attempt in between only checks, synchronously, that this observation
    // is still the one in force.
    const port: JudgmentPort = { ...base, async ask(request) {
      assertActive();
      const result = await base.ask({ ...request,
        beforeAttempt: () => { assertActive(); assertSynchronousJudgmentGuard(() => request.beforeAttempt?.()); assertActive(); },
        beforeAsyncAttempt: async () => { assertActive(); const checked = await request.beforeAsyncAttempt?.(); assertActive(); return checked; },
        assertLogCurrent: () => { assertActive(); assertSynchronousJudgmentGuard(() => request.assertLogCurrent?.(), 'retention'); assertActive(); },
      });
      assertActive(); checkAnswers(request.questions, result.answers); return result;
    } };
    return { ...observed, port };
  }

  /**
   * The code-only check before the card is typed: the page is still the
   * merchant's checkout and the submit control is the one the owner's quote
   * named. The terms are read once, by `verifyTerms`, after the card is on the
   * page, and that reading is what the click is bound to.
   */
  async checkPage(expected: CheckoutTerms, ownership: { readonly assertCurrent: () => void; readonly signal?: AbortSignal | undefined }): Promise<boolean> {
    const observed = await this.observePage(expected, ownership);
    this.invalidateTerms();
    return observed !== null;
  }

  /**
   * The terms reading after the card is typed. Without a decision model, code
   * checks the live page instead (`pageShowsApprovedTerms`): the order
   * summary's total line states the approved payable total and the delivery
   * option shown as selected is the one quoted. Anything short of that is a
   * changed quote, never a submit.
   */
  async verifyTerms(expected: CheckoutTerms, ownership: { readonly assertCurrent: () => void; readonly signal?: AbortSignal | undefined }): Promise<boolean> {
    return decisionOrClassic(() => this.readTerms(expected, ownership), () => this.checkTermsInCode(expected, ownership));
  }

  private async checkTermsInCode(expected: CheckoutTerms, ownership: { readonly assertCurrent: () => void; readonly signal?: AbortSignal | undefined }): Promise<boolean> {
    const observed = await this.observePage(expected, ownership);
    if (!observed) return false;
    const { retained, engine, state, current, assertActive } = observed;
    await current();
    const shown = pageShowsApprovedTerms(retained, state);
    assertActive();
    if (shown) this.#quote = { engine, submitTarget: retained.submitTarget, current };
    return shown;
  }

  private async readTerms(expected: CheckoutTerms, ownership: { readonly assertCurrent: () => void; readonly signal?: AbortSignal | undefined }): Promise<boolean> {
    const observed = await this.observeTerms(expected, ownership);
    if (!observed) return false;
    const { retained, engine, state, port, signal, current, assertActive } = observed;
    let run: Awaited<ReturnType<typeof checkoutTerms.run>>;
    try {
      run = await checkoutTerms.run(port, toJson(checkoutTermsView(retained, state)) as EntryType, { site: 'payments.current-checkout-terms', ...(signal === undefined ? {} : { signal }) });
    } catch (error) {
      // Live page text the reading will not take (a barcode or order number shaped like a card
      // number) leaves the quote unestablished, the same answer as a page that does not match.
      if (error instanceof JudgmentInputError) return false;
      throw error;
    }
    await current();
    const unchanged = run.readings.unchanged.outcome === 'act' && run.readings.unchanged.verdict === 'yes';
    run.recordAction(unchanged ? 'current quote matches the exact notified purchase' : 'refused changed or unestablished current quote');
    assertActive();
    if (unchanged) this.#quote = { engine, submitTarget: retained.submitTarget, current };
    return unchanged;
  }

  async readCurrentQuote(original: { readonly terms: CheckoutTerms; readonly reading: RawCheckoutReading },
    ownership: { readonly assertCurrent: () => void; readonly signal?: AbortSignal | undefined }): Promise<RawCheckoutReading | null> {
    // Without a decision model, code reads the changed page
    // (`readRepricedCheckoutInCode`): a quote only when exactly one choice of
    // its printed amounts adds up to its printed total. The owner approves it.
    return decisionOrClassic(() => this.readReplacementQuote(original, ownership), () => this.readReplacementQuoteInCode(original, ownership));
  }

  private async readReplacementQuoteInCode(original: { readonly terms: CheckoutTerms; readonly reading: RawCheckoutReading },
    ownership: { readonly assertCurrent: () => void; readonly signal?: AbortSignal | undefined }): Promise<RawCheckoutReading | null> {
    const retained = captureOwnedJson(original) as unknown as typeof original;
    const observed = await this.observePage(retained.terms, ownership);
    if (!observed) return null;
    await observed.current();
    const next = readRepricedCheckoutInCode({ previous: retained.terms, reading: retained.reading, current: observed.state });
    observed.assertActive();
    return next;
  }

  private async readReplacementQuote(original: { readonly terms: CheckoutTerms; readonly reading: RawCheckoutReading },
    ownership: { readonly assertCurrent: () => void; readonly signal?: AbortSignal | undefined }): Promise<RawCheckoutReading | null> {
    const retained = captureOwnedJson(original) as unknown as typeof original;
    const observed = await this.observeTerms(retained.terms, ownership);
    if (!observed) return null;
    let next: RawCheckoutReading | null;
    try {
      next = await readRepricedCheckout({ previous: retained.terms, reading: retained.reading, current: observed.state,
        port: observed.port, signal: observed.signal, assertCurrent: observed.current });
    } catch (error) {
      if (error instanceof JudgmentInputError) return null;
      throw error;
    }
    await observed.current();
    return next;
  }

  /**
   * The engine, with both guard checks applied.
   *
   * Every method goes through here, so there is no operation on this driver
   * that can run against an engine whose redaction is absent or is scrubbing
   * against a different object.
   */
  private async engine(): Promise<CheckoutBrowserEngine> {
    this.recovery?.assertCurrent();
    const engine = await this.deps.engineFor();
    this.recovery?.assertCurrent();
    const installed = engine.cardFieldGuard();
    if (installed === null) {
      throw new CheckoutDriverRefusal(
        'Refused: this browser was built with no card-material redaction, so anything typed into a '
        + 'checkout on it could be read straight back out of a page snapshot.',
        'Compose the browser through the checkout seam, which builds the engine with the guard the '
        + 'payments service arms.',
      );
    }
    if (installed !== this.deps.cardFieldGuard) {
      throw new CheckoutDriverRefusal(
        'Refused: this browser is scrubbing page output against a different card-material guard than '
        + 'the one this checkout arms, so material typed here would survive into reported content.',
        'Hand the seam\'s cardFieldGuard to the payments service instead of constructing a second one.',
      );
    }
    return engine;
  }

  async url(ownership?: { readonly assertCurrent: () => void; readonly signal?: AbortSignal | undefined }): Promise<string> {
    const owner = this.ownership(ownership);
    const engine = await this.engine();
    owner.assertCurrent();
    const listing = await engine.tabs({ sessionId: this.sessionId });
    owner.assertCurrent();
    const pages = listing['pages'];
    if (Array.isArray(pages)) {
      for (const entry of pages) {
        if (typeof entry !== 'object' || entry === null) continue;
        const record = entry as Record<string, unknown>;
        if (record['pageId'] !== this.pageId) continue;
        const url = record['url'];
        if (typeof url === 'string' && url.length > 0) return url;
      }
    }
    throw new CheckoutDriverRefusal(
      `Refused: page ${this.pageId} is not open in browser session ${this.sessionId}, so there is no `
      + 'checkout on it to read.',
      'Snapshot the checkout page again and start the purchase against the page id that reports back.',
    );
  }

  async fill(target: string, value: string, ownership?: { readonly assertCurrent: () => void; readonly signal?: AbortSignal | undefined }): Promise<void> {
    this.invalidateTerms();
    const owner = this.ownership(ownership);
    const engine = await this.engine();
    owner.assertCurrent();
    await engine.type(this.target, { ref: target, text: value }, owner);
    owner.assertCurrent();
  }

  async fillSecrets(
    fields: readonly { readonly target: string; readonly value: string; readonly kind: CardFieldKind }[],
    ownership?: { readonly assertCurrent: () => void; readonly signal?: AbortSignal | undefined },
  ): Promise<{ readonly filledTargets: readonly string[]; readonly failedTarget: string | null }> {
    this.invalidateTerms();
    fields = fields.map(field => ({ ...field }));
    const owner = this.ownership(ownership);
    const current = (): void => { owner.signal?.throwIfAborted(); owner.assertCurrent(); };
    current();
    if (fields.length === 0) return { filledTargets: [], failedTarget: null };
    const engine = await this.engine();
    current();
    // The flow arms before it fills, once, for every field in the batch. A
    // guard with nothing live for this page is therefore not the object the
    // flow armed, whichever object the engine holds, and typing now would put
    // material on a page the redactor is not watching.
    if (!this.deps.cardFieldGuard.hasLiveMaterial(this.sessionId, this.pageId)) {
      throw new CheckoutDriverRefusal(
        'Refused: nothing has armed card-material redaction for this page, so the card fields will '
        + 'not be typed into.',
        'Run the fill through the checkout flow, which arms the redactor before the first keystroke.',
      );
    }
    const result = await engine.fillSecretBatch(this.target, {
      fills: fields.map((field) => ({ ref: field.target, value: field.value, kind: field.kind })),
    }, owner);
    current();
    const filled = result['filled'];
    const failedRef = result['failedRef'];
    return {
      filledTargets: Array.isArray(filled) ? filled.filter((entry): entry is string => typeof entry === 'string') : [],
      failedTarget: typeof failedRef === 'string' ? failedRef : null,
    };
  }

  async choose(target: string, value: string, ownership?: { readonly assertCurrent: () => void; readonly signal?: AbortSignal | undefined }): Promise<void> {
    this.invalidateTerms();
    const owner = this.ownership(ownership);
    const engine = await this.engine();
    owner.assertCurrent();
    await engine.select(this.target, { ref: target, values: [value] }, owner);
    owner.assertCurrent();
  }

  async submitOrder(target: string, ownership?: { readonly assertCurrent: () => void; readonly signal?: AbortSignal | undefined },
    dispatch?: SubmissionDispatch): Promise<{
    readonly url: string;
    readonly orderId: string | null;
    readonly challenge?: CheckoutChallenge | null | undefined;
    readonly verified: boolean;
    readonly evidence?: OrderEvidence | null | undefined;
  }> {
    let result: Record<string, unknown>;
    let enteredClick = false;
    const quote = this.#quote;
    this.#quote = null;
    try {
      if (!quote) throw new CheckoutSubmitRefused('No fresh checkout terms are bound to this submit.');
      if (target !== quote.submitTarget) throw new CheckoutSubmitRefused('The submit control differs from the verified checkout.');
      const owner = this.ownership(ownership);
      const engine = await this.engine();
      owner.assertCurrent();
      if (engine !== quote.engine) throw new CheckoutSubmitRefused('The original checkout browser was replaced.');
      // The page the reading was bound to is re-read once, by the engine,
      // immediately before it dispatches the click (beforeDispatch).
      const current = { ...owner, assertCurrent: () => {
        try { owner.assertCurrent(); } catch { throw new CheckoutSubmitRefused('The original purchase owner or stored address changed before submission.'); }
      }, beforeDispatch: async () => {
        try { await quote.current(); owner.assertCurrent(); }
        catch (error) {
          if (error instanceof Error && error.name === 'StaleElementError') throw new CheckoutQuoteChanged();
          throw new CheckoutSubmitRefused('The current checkout could not be verified before submission.');
        }
      } };
      // The one click the order placement guard admits is this flow's own.
      markPaymentCheckoutAction(current);
      enteredClick = true;
      result = await engine.click(this.target, { ref: target }, current);
    } catch (error) {
      if (error instanceof CheckoutQuoteChanged) throw error;
      if (!enteredClick) throw new CheckoutSubmitRefused('The original checkout owner or browser became unavailable before submission.');
      throw asSubmitFailure(error);
    }
    const url = readUrl(result) ?? await this.url();
    const describe = this.deps.describeSubmission;
    if (describe === undefined) return { url, orderId: null, challenge: null, verified: false, evidence: null };
    const navigated = result['navigated'] === true;
    const described = await describe({ url, navigated, target: this.target, ...(dispatch ? { dispatch } : {}) });
    // Being wired is not evidence; what it found is, and only about this
    // dispatch: an order number or a confirmation showing this dispatch's
    // total, read after this click on the merchant's own domain. Wording
    // alone, a landing elsewhere, or no dispatch named is no evidence, and
    // the purchase stays `submitted-unverified` (settleSubmission, money.ts).
    const evidence = dispatch === undefined ? null : orderEvidenceOf(dispatch, url, described);
    const verified = evidence !== null || described.challenge !== null;
    return { url, orderId: described.orderId, challenge: described.challenge, verified, evidence };
  }
}

/** Whether the landing URL is on the merchant's registrable domain (or a host under it). */
function landedOnMerchant(url: string, merchantDomain: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { return false; }
  const merchant = merchantDomain.toLowerCase().replace(/\.$/, '');
  if (host === merchant || host.endsWith(`.${merchant}`)) return true;
  const landed = registrableDomain(host);
  return landed !== null && landed === registrableDomain(merchant);
}

/** The landing page's description as evidence about `dispatch`, or null when it ties nothing to it. */
function orderEvidenceOf(dispatch: SubmissionDispatch, url: string, described: CheckoutSubmissionDescription): OrderEvidence | null {
  if (!landedOnMerchant(url, dispatch.merchantDomain)) return null;
  if (described.orderId !== null && described.orderId.trim().length > 0) {
    return { kind: 'order-number', dispatch, orderId: described.orderId, landedFrom: 'this-submit' };
  }
  if (described.confirmed === true && described.totalShown === true) {
    return { kind: 'confirmation-with-total', dispatch, totalShown: dispatch.total, landedFrom: 'this-submit' };
  }
  return null;
}

/**
 * Classify a `submitOrder` failure as pre-click or genuinely ambiguous.
 *
 * `CheckoutDriverRefusal` is this module's own guard (identity, armed state):
 * always thrown before `engine.click` runs, so it is always pre-click.
 * Everything `engine.click` itself can throw before its one act
 * (`locator.click`), a stale/unresolved ref, the credential-page refusal, the
 * untrusted-effect guard, is named by ERROR NAME rather than by importing the
 * browser-layer classes; see this module's header for why that boundary
 * matters. Anything else, most of all a failure from the click itself, is
 * genuine ambiguity: the merchant may have received it.
 */
// JudgmentInputError: a reading's input was refused before it was built (the
// pre-click outward and credential checks); the click is never reached.
const PRE_CLICK_ERROR_NAMES = new Set(['BrowserSessionError', 'StaleElementError', 'UntrustedEffectError', 'JudgmentAuthorityRetiredError', 'JudgmentInputError', 'CheckoutSubmitRefused']);

/**
 * What checkout-flow.ts is told about a pre-click failure of each kind,
 * written by this module rather than taken from the engine's own message.
 *
 * The engine's own message can name the element it was trying to click,
 * `The button "Complete Purchase for $1,299" would not accept input`, and an
 * untrusted-effect refusal's message is built from that same page-authored
 * name (see `evaluateOutwardEffect`'s `description` in
 * security/untrusted-content.ts). checkout-flow.ts interpolates this string
 * straight into an owner-facing refusal, so forwarding it would be exactly the
 * read path fill-card.ts already refuses to open for a fill failure: an error
 * message is a page-controlled channel to whoever reads the refusal.
 */
function describePreClickFailure(name: string): string {
  switch (name) {
    case 'JudgmentAuthorityRetiredError':
    case 'CheckoutSubmitRefused':
      return 'the stored address or its reading owner changed before submission';
    case 'BrowserSessionError':
      return 'the submit control on this page could not be activated';
    case 'StaleElementError':
      return 'the page changed before the submit control could be found';
    case 'JudgmentInputError':
      return 'the order form could not be checked without sending card details to a reader, so the submit was withheld and no order was placed';
    case 'UntrustedEffectError':
      return 'content this daemon read since the purchase began (a mail or another browser page, not necessarily this order) could not be cleared against the order form, so the submit was withheld and no order was placed; approve the purchase again and begin it once nothing else is being read';
    default:
      return 'the submit could not be attempted';
  }
}

function asSubmitFailure(error: unknown): Error {
  if (error instanceof CheckoutQuoteChanged) return error;
  // Raised by this module with a fixed message of its own; rewording it would name the wrong cause.
  if (error instanceof CheckoutSubmitRefused) return error;
  if (error instanceof CheckoutDriverRefusal) {
    // This module's own guard messages (identity, armed state): they name a
    // field, a page or a missing guard, and never page-authored text. See this
    // module's header.
    return new CheckoutSubmitRefused(error.message);
  }
  if (error instanceof Error && PRE_CLICK_ERROR_NAMES.has(error.name)) {
    return new CheckoutSubmitRefused(describePreClickFailure(error.name));
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The factory `PaymentsServiceDeps.driverFor` wants.
 *
 * Synchronous, because the payments service resolves a driver per verb call and
 * the engine behind it may not exist yet. Nothing is opened until the first page
 * operation runs.
 */
export function createBrowserCheckoutDriverFactory(
  deps: BrowserCheckoutDriverDeps,
): (sessionId: string, pageId: string, recovery?: CheckoutDriverRecoveryBinding) => CheckoutPageDriver {
  deps = Object.freeze({ ...deps });
  return (sessionId, pageId, recovery) => new BrowserCheckoutPageDriver(sessionId, pageId, deps, recovery);
}
