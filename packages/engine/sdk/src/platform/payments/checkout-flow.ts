/**
 * checkout-flow.ts, the purchase, start to finish, with nothing merchant-
 * specific in it.
 *
 * ══ The order, and why it is exactly this order ═══════════════════════════
 *
 *   0  GATES              enabled, card, address, owner-direct, leader
 *   0b TAINT              the purchase must be owner-initiated; the item and any
 *                        stated limit must be the owner's. The MERCHANT may be
 *                        discovered for that owner request, see below.
 *   0c LINK               the checkout url must resolve to a registrable domain
 *   0d RECOURSE           who takes the card, and what silence will mean
 *   1  EXTRACT            page strings → integers WE parsed
 *   2  CART               what is in it is what the owner asked for, nothing added
 *   3  RECURRING          a subscription is refused outright
 *   4  DECIDE             budget, ceiling, overage pool, shipping ladder
 *   5  RESERVE            money is held before any window opens
 *   6  NOTICE + WINDOW    one message for this exact quote and final total
 *   7  APPLY SHIPPING     the tier the ladder chose
 *   8  FILL               the daemon types the card
 *   9  SUBMIT             journalled BEFORE the click
 *  10  RECORD             the audit ledger, and the budget is committed
 *
 * Extraction comes before the cart check because the check compares parsed
 * lines; the cart check comes before the decision because a cart containing
 * something the owner did not ask for should never reach a budget question; and the
 * reservation comes before the window because a window is minutes wide and two
 * purchases decided in the same minute would otherwise each fit what remains
 * and together exceed it.
 *
 * ══ Owner-named and discovered merchants, and the recourse standard ══════
 *
 * The item and any stated limit must originate with the owner. For an owner-named
 * merchant, its name and checkout URL also pass the taint check. When the owner
 * asks us to find a merchant (merchantDiscovered), discovery may supply those
 * two fields. The checkout domain is still validated, and classifyMerchant reads
 * recourse from that validated domain, never from a page's claims about itself.
 *
 * What the merchant CLASS does here is separate and strictly narrower: it can
 * make an in-budget purchase stricter. A merchant with no established recourse
 * turns a veto into an approval, so silence stops it instead of allowing it.
 * It never moves in the other direction.
 *
 * ══ ONE notification, and the merchant decides what silence means ═════════
 *
 * Design rule: "show it to me" and "alert me if it is not a major retailer" collapse
 * into a single step. There is one message, sent once, when the item is chosen and
 * the final total is known, before payment. Both modes carry the same content;
 * the merchant only changes the RULE:
 *
 *   recourse established, within budget  ⇒ VETO.     Silence PROCEEDS.
 *   anything else                        ⇒ APPROVAL. Silence DENIES.
 *
 * They compose in the strict direction only, `windowForPurchase` escalates and
 * never downgrades, so a recognised retailer buys no leniency on an over-budget
 * purchase. The two window state machines in windows.ts stay separate, because
 * their silence rules are opposite and must never be unified; this module calls
 * whichever applies and never a shared helper.
 *
 * ══ Nothing here knows a merchant ═════════════════════════════════════════
 *
 * No selector, no host, no page shape, no label vocabulary. The reading arrives
 * as structured values from whoever read the page, and every page operation
 * goes through narrow port methods whose arguments are opaque targets the caller
 * supplied. A merchant this has never seen works or nothing does.
 */
import { assertCartMatchesRequest, detectRecurringCharge, type RequestedLine } from './cart.js';
import { checkPaymentGates, type GateInput } from './gates.js';
import { requireDecisionFeature } from '../runtime/decision-policy.js';
import { captureOwnedJson } from '../gate/judgment-input.js';
import { captureMutationDescriptors } from '../utils/file-mutation.js';
import { captureCheckoutOwnership, CheckoutOwnershipError, type CheckoutOperationOwnership } from './checkout-ownership.js';
import { decidePurchase, type BudgetDraw } from './decide.js';
import { readShippingTiers } from './shipping.js';
import { evaluatePaymentTaint, type OwnerOriginIntent } from './taint-gate.js';
import { extractCheckout, type ExtractedCheckout, type RawCheckoutReading } from './checkout-extraction.js';
import { parseRequestedMaximum } from './money-parsing.js';
import {
  classifyMerchant,
  windowForPurchase,
  type MerchantJudgePort,
  type MerchantPolicy,
  type MerchantVerdict,
} from './merchant-recourse.js';
import type { MarketplaceListing } from './marketplace-listing.js';
import { renderCancellationReport, renderPurchaseNotice, renderPurchaseReport } from './message.js';
import { validateLinkTarget } from '../security/link-validation.js';
import { registrableDomain } from '../security/public-suffix.js';
import {
  advanceApproval,
  advanceVeto,
  windowDeadlineMs,
  type ApprovalState,
  type ChannelDelivery,
  type VetoState,
} from './windows.js';
import { admitApprovedItemOverdraw, BudgetLedger, type BudgetLimits } from './budget.js';
import { fillCard, type CardFieldTarget } from './fill-card.js';
import {
  checkAddress,
  fillAddresses,
  renderDestination,
  type AddressFieldTarget,
  type AddressStore,
} from './address.js';
import type { CardMaterialStore } from './card-material.js';
import type { CardMaterialRedactor } from './card-redaction.js';
import { CheckoutQuoteChanged, CheckoutSubmitRefused, type CheckoutChallenge, type CheckoutPageDriver, type CheckoutTerms } from './checkout-page.js';
import type { PurchaseRecord } from './purchase-record.js';
import type { CheckoutPageClaim, CheckoutRegistry } from './checkout-registry.js';
import { retainTaintEvidence, type RetainedTaintEvidence, type UntrustedContentLedger } from '../security/untrusted-content.js';
import { dayKey } from './day.js';
import type {
  CommandAuthorityChannel,
  CurrencyCode,
  OwnerSuppliedText,
  RefusalCode,
  ShippingStepDown,
  ShippingTier,
  PurchaseApprovalReason,
} from './types.js';

/** What the owner asked for, in their own words, from an owner-direct turn. */
export interface PurchaseRequest {
  readonly purchaseId: string;
  readonly merchantDomain: string;
  readonly checkoutUrl: string;
  readonly item: OwnerSuppliedText;
  readonly requestedLines: readonly RequestedLine[];
  readonly cardId: string;
  /**
   * Whether the owner NAMED this storefront or we found it while browsing.
   *
   * `false` puts the merchant and the checkout url through the taint check, the owner
   * named them, so they have to be the owner's. `true` skips that check by design and
   * hands the domain to the judge instead, which is the safeguard for a request phrased
   * like: "alert me prior to purchasing if it is not a major retailer".
   */
  readonly merchantDiscovered?: boolean | undefined;
  readonly preferredTier: ShippingTier;
  /** Owner's maximum full payable total as an exact amount in the budget currency.
   * Taint-checked, never page text. Exceeding it requires explicit approval. */
  readonly requestedMax?: string | undefined;

  /**
   * Where the item was browsed, when the checkout is on a different host.
   *
   * A checkout that leaves the recourse-bearing domain breaks the
   * qualification, and the notification says so rather than staying silent.
   */
  readonly storefrontHost?: string | undefined;
  /** Page-derived, carried for the audit record. Never used to infer majorness. */
  readonly sellerIdentity?: string | undefined;
  readonly saleType?: 'first-party' | 'third-party' | 'unknown' | undefined;
  /**
   * The specific listing, on marketplaces where recourse is per-seller.
   *
   * eBay's ruled behavior: Buy It Now only, and a seller-side selling record.
   * An auction is refused structurally, there is no final total before it ends,
   * so the "show the total, then wait" flow cannot run at all.
   */
  readonly listing?: MarketplaceListing | undefined;
}

export type { PurchaseRecord } from './purchase-record.js';

export type { PurchaseLedger, PaymentNotifier, PaymentNoticeWindow } from './payment-ports.js';
import type { PurchaseLedger, PaymentNotifier, PaymentNoticeWindow } from './payment-ports.js';
import { isDeepStrictEqual } from 'node:util';
import { retainResumedCheckoutHold } from './resumed-hold.js';
import { captureCheckoutWindowCheckpoint, type CheckoutWindowResumption } from './checkout-window-checkpoint.js';

export interface CheckoutFlowDeps extends CheckoutOperationOwnership {
  readonly resumeWindow?: CheckoutWindowResumption | undefined;
  /** Host-only durable quote/control checkpoint after the journal flush and
   * before arming reception. Never supplied by checkout wire arguments. */
  readonly retainWindowCheckpoint?: ((checkpoint: import('./checkout-window-checkpoint.js').CheckoutWindowCheckpoint) => Promise<void>) | undefined;
  readonly registry: CheckoutRegistry;
  readonly cards: CardMaterialStore;
  /**
   * The stored shipping and billing addresses.
   *
   * The address on the order comes from here, never from the model's memory of
   * what the owner said and never from anything on the page.
   */
  readonly addresses: AddressStore;
  readonly redactor: CardMaterialRedactor;
  readonly driver: CheckoutPageDriver;
  readonly ledger: BudgetLedger;
  readonly purchases: PurchaseLedger;
  readonly notifier: PaymentNotifier;
  readonly untrusted: UntrustedContentLedger;
  /** Host-only original source facts, never read from PurchaseRequest. */
  readonly taintEvidence?: RetainedTaintEvidence | undefined;
  readonly limits: BudgetLimits;
  readonly budgetCurrency: CurrencyCode;
  readonly timezone: string;
  readonly gates: GateInput;
  readonly approvalMinutes: number;
  readonly vetoMinutes: number;
  readonly now: () => number;
  /** Judges the merchant's recourse from its validated domain alone. */
  readonly merchantJudge: MerchantJudgePort;
  /** Owner-authored overrides from daemon config. */
  readonly merchantPolicy?: MerchantPolicy | undefined;
}

/**
 * Where the card fields are, and where the delivery and submit controls are.
 *
 * Supplied by the caller for the page it is actually looking at. This module
 * has no opinion about any of them, which is what lets it work on a merchant
 * nobody has written anything about.
 */
export interface CheckoutControls {
  readonly cardFields: readonly CardFieldTarget[];
  /**
   * Where each address field goes on this checkout.
   *
   * Empty when the checkout asks for no address, a digital order, or a page
   * that already has one on file. Every KIND named here must be stored in full
   * or the purchase refuses.
   */
  readonly addressFields?: readonly AddressFieldTarget[] | undefined;
  /** Target for each delivery option, in the same order as the reading's list. */
  readonly shippingTargets: readonly string[];
  readonly placeOrderTarget: string;
  readonly expirySeparator?: string | undefined;
  readonly twoDigitYear?: boolean | undefined;
}

/**
 * Refusals this layer can produce that the decision layer has no code for.
 *
 * Kept here rather than added to `RefusalCode` because they are execution-layer
 * facts: a listing format we will not buy, and an approval window that closed
 * for a reason that had nothing to do with the budget. Folding them into the
 * budget codes would make `payments.purchases.list` report "over budget" for a
 * purchase that was well within it and simply happened at a merchant the owner had not
 * vouched for.
 */
export type ExecutionRefusalCode =
  | 'extraction-failed'
  /** An auction, a Best Offer, or a format we could not confirm as fixed-price. */
  | 'listing-not-purchasable'
  | 'merchant-not-recognised-denied'
  | 'merchant-not-recognised-expired'
  | 'merchant-not-recognised-undeliverable';

export type CheckoutOutcome =
  | { readonly kind: 'refused'; readonly code: RefusalCode | ExecutionRefusalCode; readonly reason: string }
  | { readonly kind: 'cancelled'; readonly reason: string; readonly report: string }
  | { readonly kind: 'challenge'; readonly challenge: CheckoutChallenge; readonly reason: string }
  | {
      readonly kind: 'purchased';
      readonly record: PurchaseRecord;
      readonly orderId: string | null;
    };

function refused(code: RefusalCode | ExecutionRefusalCode, reason: string): CheckoutOutcome {
  return { kind: 'refused', code, reason };
}

/**
 * Run a purchase.
 *
 * Every exit either charges nothing and says why, or charges once and records
 * it. There is no path that submits without a journal entry written first, and
 * no path that retries a submit.
 */
export async function runCheckout(
  request: PurchaseRequest,
  reading: RawCheckoutReading,
  controls: CheckoutControls,
  deps: CheckoutFlowDeps,
): Promise<CheckoutOutcome> {
  requireDecisionFeature('automated checkout cart and merchant interpretation');
  deps = { ...deps };
  const input = captureOwnedJson({ request, reading, controls, gates: deps.gates, limits: deps.limits,
    merchantPolicy: deps.merchantPolicy }) as {
    request: PurchaseRequest; reading: RawCheckoutReading; controls: CheckoutControls;
    gates: GateInput; limits: BudgetLimits; merchantPolicy: MerchantPolicy | undefined;
  };
  const owner = captureCheckoutOwnership(deps);
  const driverCurrent = captureMutationDescriptors(deps.driver, ['identity', 'verifyTerms', 'readCurrentQuote', 'url', 'fill', 'fillSecrets', 'choose', 'submitOrder']);
  const current = () => {
    owner.assertCurrent();
    try { driverCurrent(); } catch { throw new CheckoutOwnershipError(); }
    owner.assertCurrent();
  };
  const resumption = deps.resumeWindow === undefined ? undefined : Object.freeze({
    checkpoint: captureCheckoutWindowCheckpoint(deps.resumeWindow.checkpoint), prepare: deps.resumeWindow.prepare.bind(deps.resumeWindow) });
  if (resumption && (resumption.checkpoint.record.purchaseId !== input.request.purchaseId
    || resumption.checkpoint.record.cardId !== input.request.cardId || resumption.checkpoint.record.item !== input.request.item)) throw new CheckoutOwnershipError();
  const lifecycle: CheckoutExecutionLifetime = { current, submitMayHaveHappened: false, resumption };
  current();
  deps = { ...deps, taintEvidence: deps.taintEvidence === undefined ? retainTaintEvidence(deps.untrusted)
    : captureOwnedJson(deps.taintEvidence) as RetainedTaintEvidence };
  try {
    let currentReading = resumption?.checkpoint.reading ?? input.reading;
    for (;;) {
      current();
      const result = await runOwnedCheckout(input.request, currentReading, input.controls,
        { ...deps, gates: input.gates, limits: input.limits, merchantPolicy: input.merchantPolicy }, lifecycle);
      if (result.kind !== 'reprice') {
        if ((result.kind === 'refused' || result.kind === 'cancelled') && lifecycle.release && !lifecycle.submitMayHaveHappened) await lifecycle.release();
        return result;
      }
      current();
      currentReading = result.reading;
    }
  } catch (error) {
    if (lifecycle.release && !lifecycle.submitMayHaveHappened) {
      try { await lifecycle.release(); }
      catch { throw new Error('Checkout stopped before submission, but its journal or budget hold could not be released. Inspect this purchase before retrying.'); }
    }
    throw error;
  } finally {
    lifecycle.pageClaim?.release();
  }
}

interface CheckoutExecutionLifetime {
  readonly current: () => void;
  originalPage?: ReturnType<CheckoutPageDriver['identity']> | undefined;
  originalAddress?: ReturnType<typeof captureCheckoutOwnership> | undefined;
  pageClaim?: CheckoutPageClaim | undefined;
  release?: (() => Promise<void>) | undefined;
  submitMayHaveHappened: boolean;
  resumption?: CheckoutWindowResumption | undefined;
  resumedHold?: ReturnType<typeof retainResumedCheckoutHold> | undefined;
}

type CheckoutAttemptOutcome = CheckoutOutcome | { readonly kind: 'reprice'; readonly reading: RawCheckoutReading };

async function runOwnedCheckout(request: PurchaseRequest, reading: RawCheckoutReading, controls: CheckoutControls,
  deps: CheckoutFlowDeps, lifecycle: CheckoutExecutionLifetime): Promise<CheckoutAttemptOutcome> {
  const { registry, driver, ledger, notifier, now } = deps;
  const signal = deps.signal;
  const resumption = lifecycle.resumption;
  lifecycle.resumption = undefined;
  let originalPage: ReturnType<CheckoutPageDriver['identity']> | undefined;
  let identityReader: CheckoutPageDriver['identity'] | undefined;
  let termsReader: CheckoutPageDriver['verifyTerms'];
  let quoteReader: CheckoutPageDriver['readCurrentQuote'];
  let quoteReaderCaptured = false;
  const current = (): void => {
    lifecycle.current();
    lifecycle.originalAddress?.assertCurrent();
    lifecycle.pageClaim?.assertCurrent();
    lifecycle.resumedHold?.assertCurrent();
    if (termsReader && driver.verifyTerms !== termsReader) throw new CheckoutOwnershipError();
    if (quoteReaderCaptured && driver.readCurrentQuote !== quoteReader) throw new CheckoutOwnershipError();
    if (originalPage && identityReader) {
      if (driver.identity !== identityReader) throw new CheckoutOwnershipError();
      const page = identityReader.call(driver);
      if (page.sessionId !== originalPage.sessionId || page.pageId !== originalPage.pageId) throw new CheckoutOwnershipError();
    }
  };
  const ownership = { signal, assertCurrent: current };
  current();

  if (resumption) {
    identityReader = driver.identity;
    originalPage = Object.freeze({ ...identityReader.call(driver) });
    lifecycle.originalPage = originalPage;
    lifecycle.pageClaim = registry.claimPage(originalPage.sessionId, originalPage.pageId);
    lifecycle.resumedHold = retainResumedCheckoutHold(ledger, resumption.checkpoint.record);
    const retainedHold = lifecycle.resumedHold;
    current();
    await registry.resumeWindow(resumption.checkpoint.record, originalPage, lifecycle.pageClaim, current);
    lifecycle.release = async () => {
      retainedHold.release(); lifecycle.resumedHold = undefined;
      await registry.close(request.purchaseId);
      lifecycle.release = undefined;
    };
    current();
  }

  // ── 0. Terminal gates ───────────────────────────────────────────────────
  const gateRefusal = checkPaymentGates(deps.gates);
  if (gateRefusal !== null) return refused(gateRefusal.code, gateRefusal.reason);
  const requestedMaximumMinorUnits = request.requestedMax === undefined ? undefined : parseRequestedMaximum(request.requestedMax, deps.budgetCurrency);
  if (requestedMaximumMinorUnits === null) return refused('invalid-requested-maximum', 'Refused: requestedMax must be an exact non-negative amount in the budget currency. Clarify the requested maximum before starting this purchase.');
  const verifyTerms = driver.verifyTerms;
  if (typeof verifyTerms !== 'function') return refused('total-changed', 'Refused: this checkout driver cannot verify the current cart and payable total. Nothing was submitted.');
  termsReader = verifyTerms;
  const readCurrentQuote = driver.readCurrentQuote;
  quoteReader = readCurrentQuote; quoteReaderCaptured = true;
  // Capture the original financial reader before any asynchronous work. Other
  // purchases may append legitimately; availability, rather than unchanged
  // whole-ledger content, is the restriction on this purchase's next submit.
  const purchaseEvidence = captureCheckoutOwnership({ signal,
    assertCurrent: deps.purchases.assertAvailable?.bind(deps.purchases) });
  identityReader = driver.identity;
  const identity = Object.freeze({ ...identityReader.call(driver) });
  if (lifecycle.originalPage && (identity.sessionId !== lifecycle.originalPage.sessionId || identity.pageId !== lifecycle.originalPage.pageId)) throw new CheckoutOwnershipError();
  lifecycle.originalPage ??= identity;
  lifecycle.pageClaim ??= registry.claimPage(identity.sessionId, identity.pageId);
  originalPage = identity;
  current();

  // ── 0b. Taint: what is named must trace back to the owner ───────────────
  //
  // The item and any stated limit are checked against untrusted content read
  // this turn. Owner-named merchants and URLs are checked too; explicit
  // merchant discovery exempts only those two fields. The merchant's quoted
  // NUMBERS are deliberately not checked, they are read from the merchant by
  // definition, and their defence is the budget. See taint-gate.ts.
  const intent: OwnerOriginIntent = {
    // `runCheckout` is only ever reached from an owner-direct turn, gate 0
    // above refuses anything else, so the origin is 'owner' by construction.
    // A content-initiated purchase cannot build this value at all:
    // ContentOriginIntent has no merchantDiscovered and is refused with no
    // approval path. See taint-gate.ts.
    origin: 'owner',
    merchantDiscovered: request.merchantDiscovered ?? false,
    merchant: request.merchantDomain,
    checkoutUrl: request.checkoutUrl,
    item: request.item,
    requestedMax: request.requestedMax,
  };
  const taint = await evaluatePaymentTaint({ intent, ledger: deps.untrusted, evidence: deps.taintEvidence, signal });
  current();
  if (!taint.allowed) {
    return refused('derived-from-untrusted-content', taint.reason ?? 'Refused: this purchase derives from page content.');
  }

  // ── 0c. The checkout url must resolve, and must be the domain claimed ───
  const link = await validateLinkTarget(request.checkoutUrl, request.merchantDomain, signal);
  current();
  if (!link.ok) return refused('link-validation-failed', link.message);
  // The identity the owner is shown is computed by us from the validated url,
  // never a name the page claimed for itself.
  const merchantDomain = link.registrableDomain;

  // ── 0d. Who takes the card, and what silence will therefore mean ────────
  //
  // Run on the VALIDATED host, before any money math, so a listing we will not
  // buy at all, an auction, a Best Offer, stops here rather than after a
  // budget question that could never have applied to it.
  // Judged on the validated registrable domain ALONE, by an injected judge,
  // never a curated list. Everything else a page says about a merchant is
  // written by that merchant, so a judgement over it is one the attacker
  // writes. See merchant-recourse.ts.
  const merchantVerdict: MerchantVerdict = await classifyMerchant(
    {
      checkoutHost: link.host,
      ...(request.storefrontHost === undefined ? {} : { storefrontHost: request.storefrontHost }),
      ...(request.saleType === undefined ? {} : { saleType: request.saleType }),
      ...(request.listing === undefined ? {} : { listing: request.listing }),
    },
    deps.merchantJudge,
    deps.merchantPolicy ?? {},
    ownership,
  );
  current();
  if (merchantVerdict.refused === true) {
    // Terminal, and deliberately not an approval: there is no final total to
    // show the owner, so the flow the owner authorised has nothing to run on.
    return refused('listing-not-purchasable', merchantVerdict.reason);
  }

  // ── 1. Page strings become integers we parsed ───────────────────────────
  const extraction = extractCheckout(reading, deps.budgetCurrency);
  if (!extraction.ok) return refused('extraction-failed', extraction.reason);
  const checkout: ExtractedCheckout = extraction.checkout;

  // ── 2. The cart holds what the owner asked for and nothing else ─────────
  const cartCheck = await assertCartMatchesRequest(checkout.lines, request.requestedLines, ownership);
  current();
  if (!cartCheck.ok) return refused('cart-mismatch', cartCheck.reason ?? 'Refused: the cart does not match the request.');

  // ── 3. A recurring charge is refused outright ───────────────────────────
  const recurring = await detectRecurringCharge(checkout.orderSummaryText, ownership);
  current();
  if (recurring.recurring) {
    return refused('recurring-charge', recurring.reason ?? 'Refused: this checkout sets up a recurring charge.');
  }

  // ── 4. The decision, on OUR integers ────────────────────────────────────
  // Which offered option is each shipping tier is read (shipping.ts); the ladder is arithmetic.
  const shippingTiers = await readShippingTiers(checkout.shippingOptions, checkout.currency, ownership);
  current();
  const pools = lifecycle.resumedHold ? lifecycle.resumedHold.snapshot(deps.limits, now(), deps.timezone)
    : ledger.snapshot(deps.limits, now(), deps.timezone);
  const decision = decidePurchase({
    quoted: {
      itemMinorUnits: checkout.itemMinorUnits,
      taxMinorUnits: checkout.taxMinorUnits,
      mandatoryFeesMinorUnits: checkout.feesMinorUnits,
      currency: checkout.currency,
      shippingOptions: checkout.shippingOptions, shippingTiers,
    },
    limits: deps.limits,
    pools,
    budgetCurrency: deps.budgetCurrency,
    preferredTier: request.preferredTier,
    requestedMaximumMinorUnits,
  });
  if (decision.kind === 'refuse') return refused(decision.code, decision.reason);

  const draw: BudgetDraw = decision.draw;
  const shipping = decision.shipping;
  const stepDown: ShippingStepDown | null = shipping.stepDown;
  const expectedTerms = captureOwnedJson({
    submitTarget: controls.placeOrderTarget,
    merchantDomain, currency: checkout.currency, lines: checkout.lines,
    taxMinorUnits: checkout.taxMinorUnits, feesMinorUnits: checkout.feesMinorUnits, feeLabels: checkout.feeLabels,
    shippingLabel: shipping.option.rawLabel, shippingMinorUnits: shipping.costMinorUnits, totalMinorUnits: draw.totalMinorUnits,
  }) as unknown as CheckoutTerms;
  if (resumption && (!resumption.checkpoint.terms || !isDeepStrictEqual(resumption.checkpoint.terms, expectedTerms)
    || !isDeepStrictEqual(resumption.checkpoint.record.draw, draw) || resumption.checkpoint.record.shippingTierUsed !== shipping.tier)) {
    // An older checkpoint lacks its exact selection, or the current decision
    // selects different terms. Void that window before creating a fresh one.
    await lifecycle.release?.(); current(); return { kind: 'reprice', reading };
  }

  // ── 5. Hold the money before any window opens ───────────────────────────
  //
  // An over-budget purchase does not fit the item pool, that is what makes it
  // over budget, so reserving it against the ordinary limits returns null and
  // the purchase dies before the owner is ever asked. That would make the approval
  // window unreachable for the one case it exists for, so the reservation for a
  // needs-approval purchase is taken against a limit raised by exactly this
  // purchase's shortfall, and released in full if the owner says no or says nothing.
  //
  // Narrow on purpose: only the ITEM limit is raised, and only for a purchase
  // the decision layer has already classified as needing the owner's yes. The
  // overage and tolerance allowances are untouched, so `overage-pool-exhausted`
  // still refuses exactly as before rather than being quietly funded by an
  // approval the owner gave for the item price.
  const reservationLimits = decision.kind === 'needs-approval'
    ? admitApprovedItemOverdraw(deps.limits, draw.itemMinorUnits, pools.item.remaining)
    : deps.limits;
  current();
  const reservation = lifecycle.resumedHold?.reservation ?? ledger.reserve({
    id: request.purchaseId,
    itemMinorUnits: draw.itemMinorUnits,
    overageMinorUnits: draw.overageMinorUnits,
    toleranceMinorUnits: draw.toleranceMinorUnits,
    limits: reservationLimits,
    nowMs: now(),
    timezone: deps.timezone,
    retainUntilSettled: true,
  });
  if (reservation === null) {
    return refused(
      'item-budget-exceeded-denied',
      'Refused: another purchase in flight is already holding the budget this one would need.',
    );
  }

  if (!resumption) try {
    await registry.open({
      purchaseId: request.purchaseId,
      sessionId: identity.sessionId,
      pageId: identity.pageId,
      merchantDomain,
      cardId: request.cardId,
      item: request.item,
      currency: checkout.currency,
      phase: 'deciding',
      startedAtMs: now(),
      updatedAtMs: now(),
      draw,
      reservationId: reservation.id,
      shippingTierRequested: request.preferredTier,
      shippingTierUsed: shipping.tier,
      stepDown,
      totalMinorUnits: draw.totalMinorUnits,
    }, lifecycle.pageClaim);
  } catch (error) {
    // This attempt never acquired a durably published checkout. Release only
    // its newly reserved budget; do not close another purchase on this page.
    ledger.release(reservation.id);
    throw error;
  }

  /**
   * Give the money back and close the record. Used by every non-buying exit.
   *
   * Deliberately does NOT disarm the redactor. Most callers of `release` run
   * before `fillCard` ever arms anything, so there would be nothing to disarm;
   * the callers that run AFTER it (a fill that failed partway, a pre-click
   * submit refusal) are exactly the ones where card digits may still be sitting
   * in the page's DOM with no click having dispatched them anywhere. Disarming
   * there would stop redacting a page that still holds the card. Material
   * lifetime is bound to the PAGE instead: only actual page or owned-browser
   * closure disarms it. Navigation and URL changes alone do not establish
   * that card material is gone.
   */
  const resumedHold = lifecycle.resumedHold;
  const release = async (): Promise<void> => {
    if (resumedHold) resumedHold.release(); else ledger.release(reservation.id);
    lifecycle.resumedHold = undefined;
    await registry.close(request.purchaseId);
    lifecycle.release = undefined;
  };
  lifecycle.release = release;
  current();

  // ── The address goes on the order, and it is the one the owner stored ───
  //
  // Checked BEFORE the window: a purchase that cannot be delivered must not
  // reach the point of asking the owner about it, and a half-filled address form
  // is worse than a refusal because it can succeed.
  const addressFields = controls.addressFields ?? [];
  const addressKinds = [...new Set(addressFields.map((entry) => entry.kind))];
  let addresses: AddressStore;
  try {
    addresses = deps.addresses.prepare ? await deps.addresses.prepare(addressKinds, { signal }) : deps.addresses;
    current();
    addresses.assertCurrent?.();
    for (const kind of addressKinds) {
      const stored = await addresses.read(kind, { signal });
      current(); addresses.assertCurrent?.();
      const check = checkAddress(stored, kind);
      if (!check.ok) {
        await release();
        return refused(kind === 'shipping' ? 'no-shipping-address' : 'no-card', check.reason ?? 'Refused: the stored address is incomplete.');
      }
    }
  } catch {
    await release();
    return refused('no-shipping-address', 'The stored address could not be verified for this purchase. Nothing was submitted.');
  }
  const retainedAddress = captureCheckoutOwnership({ signal, assertCurrent: addresses.assertCurrent?.bind(addresses) });
  lifecycle.originalAddress ??= retainedAddress;
  const addressCurrent = () => { current(); retainedAddress.assertCurrent(); };
  const addressStillCurrent = () => { try { addressCurrent(); return true; } catch { return false; } };
  const reprice = async (): Promise<CheckoutAttemptOutcome> => {
    // The old answer and its held amount are void before any new reading.
    // This path is reachable only while a submit is known not to have happened.
    await release(); addressCurrent();
    if (typeof readCurrentQuote !== 'function') return refused('total-changed', 'The checkout terms changed and this browser cannot read a verified replacement quote. Nothing was submitted.');
    const next = await readCurrentQuote.call(driver, { terms: expectedTerms, reading }, { signal, assertCurrent: addressCurrent });
    addressCurrent();
    if (!next) return refused('total-changed', 'The changed checkout could not establish a complete replacement quote for the same purchase. Nothing was submitted.');
    const retained = captureOwnedJson(next) as unknown as RawCheckoutReading;
    const extracted = extractCheckout(retained, deps.budgetCurrency);
    if (!extracted.ok) return refused('extraction-failed', extracted.reason);
    const fresh = extracted.checkout;
    const samePrices = fresh.currency === checkout.currency && fresh.taxMinorUnits === checkout.taxMinorUnits
      && fresh.feesMinorUnits === checkout.feesMinorUnits
      && fresh.lines.length === checkout.lines.length && fresh.lines.every((line, index) => {
        const original = checkout.lines[index];
        return original && line.quantity === original.quantity && line.unitMinorUnits === original.unitMinorUnits;
      })
      && fresh.shippingOptions.length === checkout.shippingOptions.length && fresh.shippingOptions.every((option, index) => {
        const original = checkout.shippingOptions[index];
        return original && option.costMinorUnits === original.costMinorUnits;
      });
    if (samePrices) return refused('total-changed', 'The earlier quote could not be verified, and no changed price was established. Nothing was submitted.');
    // Iterative re-entry avoids retaining earlier request/window stacks. The
    // next attempt reads the live budget and creates a completely new window.
    return { kind: 'reprice', reading: retained };
  };
  let shippingAddress;
  try { shippingAddress = addressKinds.includes('shipping') ? await addresses.read('shipping', { signal }) : null; addressCurrent(); }
  catch { await release(); return refused('no-shipping-address', 'The stored address changed before this purchase could proceed.'); }

  const metadata = await deps.cards.metadata(request.cardId);
  current();
  const cardLast4 = metadata?.last4 ?? '????';
  const poolsAfter = ledger.snapshot(deps.limits, now(), deps.timezone);

  const facts = {
    merchantDomain,
    item: request.item,
    itemMinorUnits: checkout.itemMinorUnits,
    taxMinorUnits: checkout.taxMinorUnits,
    feesMinorUnits: checkout.feesMinorUnits,
    shippingMinorUnits: shipping.costMinorUnits,
    totalMinorUnits: draw.totalMinorUnits,
    currency: checkout.currency,
    cardLast4,
    shippingTier: shipping.tier,
    stepDown,
    poolsAfter,
    destination: renderDestination(shippingAddress),
    ...(requestedMaximumMinorUnits === undefined ? {} : { requestedMaximumMinorUnits }),
    approvalReasons: [
      ...(decision.kind === 'needs-approval' ? decision.approvalReasons : []),
      ...(!merchantVerdict.isMajor ? ['merchant-recourse' as const] : []),
    ] satisfies readonly PurchaseApprovalReason[],
  };

  // ── 6. One notification for this quote, and its new window ──────────────
  //
  // Sent once, here, because this is the first moment both halves of what the
  // owner asked to see are known: WHAT was chosen, and what it will actually
  // cost. An actual reprice voids this answer and starts a different quote and
  // window. It never reuses this notification's answer for another amount.
  await registry.advance(request.purchaseId, 'awaiting-window', {}, now());
  addressCurrent();

  const exceedsRequestedMaximum = requestedMaximumMinorUnits !== undefined && draw.totalMinorUnits > requestedMaximumMinorUnits;
  const aboveBudget = decision.kind === 'needs-approval' && decision.approvalReasons.some(reason => reason !== 'requested-maximum');
  const budgetDescription = decision.kind === 'needs-approval' && decision.approvalReasons.includes('per-purchase-ceiling')
    ? decision.approvalReasons.includes('daily-item-budget') ? 'your configured item spending limits' : 'your per-purchase ceiling'
    : 'your remaining daily item budget';
  const windowKind: 'approval' | 'veto' = windowForPurchase({
    aboveBudget,
    aboveRequestedMaximum: exceedsRequestedMaximum,
    merchantIsMajor: merchantVerdict.isMajor,
  });
  if (resumption && resumption.checkpoint.record.windowKind !== windowKind) {
    await release(); addressCurrent(); return { kind: 'reprice', reading };
  }
  if (resumption) {
    const sameQuote = await verifyTerms.call(driver, expectedTerms, { signal, assertCurrent: addressCurrent });
    addressCurrent();
    if (!sameQuote) return reprice();
  }
  let windowOutcome: string;
  let answeredBy: string | null = null;

  if (windowKind === 'approval') {
    // Silence DENIES. Undeliverable DENIES. Either because it is over budget,
    // or because nobody can tell the owner what recourse they would have here.
    const message = resumption?.checkpoint.record.windowNotice ?? renderPurchaseNotice({
      facts,
      mode: 'approval',
      expiresInMinutes: deps.approvalMinutes,
      merchantReason: merchantVerdict.reason,
    });
    if (!addressStillCurrent()) { await release(); return refused('no-shipping-address', 'The stored address changed before the purchase notice.'); }
    let reception: PaymentNoticeWindow | undefined;
    let restoredDeadline: Promise<number> | undefined;
    let state: ApprovalState;
    try {
      let deliveries: readonly ChannelDelivery[];
      try {
        if (resumption) {
          const restored = resumption.prepare({ signal, assertCurrent: addressCurrent });
          reception = Object.freeze({ deliveries: restored.deliveries, awaitAnswer: restored.awaitAnswer.bind(restored), cancel: restored.cancel.bind(restored) });
          restoredDeadline = restored.deadlineMs;
        } else reception = notifier.prepareWindow?.({ purchaseId: request.purchaseId, kind: 'approval', notice: message, assertCurrent: addressCurrent, signal });
        deliveries = await (reception?.deliveries ?? notifier.deliver({ kind: 'approval', message, assertCurrent: addressCurrent, signal }));
        addressCurrent();
      }
      catch { await release(); return refused('no-shipping-address', 'The address reading or purchase notice became unavailable. Nothing was submitted.'); }
      const deadlineMs = resumption ? await restoredDeadline : windowDeadlineMs(now(), deps.approvalMinutes);
      addressCurrent();
      if (typeof deadlineMs !== 'number' || !Number.isSafeInteger(deadlineMs) || deadlineMs < 0) throw new CheckoutOwnershipError();
      // Persisted so a restart can apply the delivery-keyed recovery rules.
      const checkpoint = await registry.advance(request.purchaseId, 'awaiting-window', { windowDeliveries: deliveries, windowDeadlineMs: deadlineMs, windowKind, windowNotice: message }, now());
      addressCurrent();
      state = advanceApproval('pending-dispatch', { kind: 'dispatched', deliveries });
      if (state === 'awaiting-approval') {
        await deps.retainWindowCheckpoint?.({ record: checkpoint, reading, terms: expectedTerms });
        addressCurrent();
        let answer: Awaited<ReturnType<PaymentNotifier['awaitAnswer']>>;
        try {
          answer = await (reception ? reception.awaitAnswer(deadlineMs)
            : notifier.awaitAnswer({ purchaseId: request.purchaseId, kind: 'approval', notice: message, deadlineMs, signal }));
          addressCurrent();
        } catch (error) { await release(); throw error; }
        if (answer === null) {
          state = advanceApproval(state, { kind: 'deadline' });
        } else {
          answeredBy = answer.channel;
          state = advanceApproval(
            state,
            answer.answer === 'approve'
              ? { kind: 'approve', channel: answer.channel }
              : { kind: 'deny', channel: answer.channel },
          );
        }
      }
    } finally { reception?.cancel(); }
    windowOutcome = state;
    if (state !== 'approved') {
      await release();
      // The code says WHY the window was an approval, because the ledger row is
      // the only place the owner can later reconstruct that. "Over budget" on a
      // purchase that was comfortably within it, and merely at a shop nobody
      // could vouch for, is a lie the audit trail would keep repeating.
      const code: RefusalCode | ExecutionRefusalCode = aboveBudget
        ? state === 'denied-undeliverable'
          ? 'item-budget-exceeded-undeliverable'
          : state === 'denied-timeout'
            ? 'item-budget-exceeded-expired'
            : 'item-budget-exceeded-denied'
        : exceedsRequestedMaximum
          ? state === 'denied-undeliverable'
            ? 'requested-maximum-exceeded-undeliverable'
            : state === 'denied-timeout'
              ? 'requested-maximum-exceeded-expired'
              : 'requested-maximum-exceeded-denied'
        : state === 'denied-undeliverable'
          ? 'merchant-not-recognised-undeliverable'
          : state === 'denied-timeout'
            ? 'merchant-not-recognised-expired'
            : 'merchant-not-recognised-denied';
      const why = aboveBudget
        ? state === 'denied-undeliverable'
          ? `Refused: this item exceeds ${budgetDescription} and I could not reach you to ask. `
            + 'Over-budget purchases do not go through unasked.'
          : state === 'denied-timeout'
            ? `Refused: this item exceeds ${budgetDescription} and the approval window closed with no answer. `
              + 'Silence on an over-budget purchase means no.'
            : 'Refused: you said no.'
        : exceedsRequestedMaximum
          ? state === 'denied-undeliverable'
            ? 'Refused: this total exceeds the maximum in your request and I could not reach you for explicit approval. Nothing was bought.'
            : state === 'denied-timeout'
              ? 'Refused: this total exceeds the maximum in your request and the approval window ended without an answer. Silence does not raise your limit.'
              : 'Refused: you did not approve spending above the maximum in your request.'
        : state === 'denied-undeliverable'
          ? 'Refused: I could not reach you to ask about this merchant, and a purchase somewhere '
            + 'I cannot point to a way of getting your money back does not go through unasked.'
          : state === 'denied-timeout'
            ? 'Refused: the window closed with no answer. Silence means no when the shop is not one '
              + 'you have vouched for.'
            : 'Refused: you said no.';
      return refused(code, aboveBudget || exceedsRequestedMaximum ? why : `${why} ${merchantVerdict.reason}`);
    }
  } else {
    // WITHIN BUDGET AND RECOURSE ESTABLISHED. Silence PROCEEDS. Undeliverable
    // PROCEEDS.
    const message = resumption?.checkpoint.record.windowNotice ?? renderPurchaseNotice({
      facts,
      mode: 'veto',
      expiresInMinutes: deps.vetoMinutes,
      merchantReason: merchantVerdict.reason,
    });
    if (!addressStillCurrent()) { await release(); return refused('no-shipping-address', 'The stored address changed before the purchase notice.'); }
    let reception: PaymentNoticeWindow | undefined;
    let restoredDeadline: Promise<number> | undefined;
    let state: VetoState;
    try {
      let deliveries: readonly ChannelDelivery[];
      try {
        if (resumption) {
          const restored = resumption.prepare({ signal, assertCurrent: addressCurrent });
          reception = Object.freeze({ deliveries: restored.deliveries, awaitAnswer: restored.awaitAnswer.bind(restored), cancel: restored.cancel.bind(restored) });
          restoredDeadline = restored.deadlineMs;
        } else reception = notifier.prepareWindow?.({ purchaseId: request.purchaseId, kind: 'veto', notice: message, assertCurrent: addressCurrent, signal });
        deliveries = await (reception?.deliveries ?? notifier.deliver({ kind: 'veto', message, assertCurrent: addressCurrent, signal }));
        addressCurrent();
      }
      catch { await release(); return refused('no-shipping-address', 'The address reading or purchase notice became unavailable. Nothing was submitted.'); }
      const deadlineMs = resumption ? await restoredDeadline : windowDeadlineMs(now(), deps.vetoMinutes);
      addressCurrent();
      if (typeof deadlineMs !== 'number' || !Number.isSafeInteger(deadlineMs) || deadlineMs < 0) throw new CheckoutOwnershipError();
      // Persisted so a restart can apply the delivery-keyed recovery rules.
      const checkpoint = await registry.advance(request.purchaseId, 'awaiting-window', { windowDeliveries: deliveries, windowDeadlineMs: deadlineMs, windowKind, windowNotice: message }, now());
      addressCurrent();
      state = advanceVeto('pending-dispatch', { kind: 'dispatched', deliveries });
      if (state === 'open') {
        await deps.retainWindowCheckpoint?.({ record: checkpoint, reading, terms: expectedTerms });
        addressCurrent();
        let answer: Awaited<ReturnType<PaymentNotifier['awaitAnswer']>>;
        try {
          answer = await (reception ? reception.awaitAnswer(deadlineMs)
            : notifier.awaitAnswer({ purchaseId: request.purchaseId, kind: 'veto', notice: message, deadlineMs, signal }));
          addressCurrent();
        } catch (error) { await release(); throw error; }
        if (answer === null) {
          state = advanceVeto(state, { kind: 'deadline' });
        } else {
          answeredBy = answer.channel;
          state = advanceVeto(
            state,
            answer.answer === 'object'
              ? { kind: 'object', channel: answer.channel }
              : { kind: 'acknowledge', channel: answer.channel },
          );
        }
      }
    } finally { reception?.cancel(); }
    windowOutcome = state;
    if (state === 'cancelled') {
      await release();
      // An objection stops AND reports. A silently abandoned cart leaves the
      // owner wondering whether something is sitting half-driven somewhere.
      return {
        kind: 'cancelled',
        reason: 'You said stop, so nothing was charged.',
        report: renderCancellationReport(facts),
      };
    }
  }

  if (!addressStillCurrent()) { await release(); return refused('no-shipping-address', 'The stored address changed while awaiting your answer. Nothing was submitted.'); }

  // ── 7. Apply the delivery option the ladder chose ───────────────────────
  const chosenIndex = checkout.shippingOptions.findIndex(
    (option) => option.rawLabel === shipping.option.rawLabel
      && option.costMinorUnits === shipping.option.costMinorUnits,
  );
  const shippingTarget = chosenIndex === -1 ? undefined : controls.shippingTargets[chosenIndex];
  if (shippingTarget !== undefined) {
    try {
      addressCurrent();
      await driver.choose(shippingTarget, shipping.option.rawLabel, { signal, assertCurrent: addressCurrent });
      addressCurrent();
    } catch {
      await release();
      return refused('total-changed', 'Refused: the delivery option I chose could not be selected on this checkout.');
    }
  }

  // ── 8. The daemon puts the address and then the card on the page ────────
  //
  // Address first: it is not secret, so it needs no guard, and doing it before
  // the card means a checkout that rejects the address fails before any card
  // material has been typed anywhere.
  if (addressFields.length > 0) {
    const addressFill = await fillAddresses(addressFields, {
      store: addresses, signal, assertCurrent: addressCurrent,
      fill: (target, value) => driver.fill(target, value, { assertCurrent: addressCurrent, signal }),
    });
    addressCurrent();
    if (!addressFill.ok) {
      await release();
      return refused(
        'no-shipping-address',
        `${addressFill.reason ?? 'The address could not be put on this checkout.'} Nothing was submitted.`,
      );
    }
  }

  if (!addressStillCurrent()) { await release(); return refused('no-shipping-address', 'The stored address changed before payment entry. Nothing was submitted.'); }
  // Shipping selection and address entry can change tax, fees and the cart.
  // The notice approves exactly its earlier parsed quote, never a larger limit.
  const beforeCard = await verifyTerms.call(driver, expectedTerms, { signal, assertCurrent: addressCurrent });
  addressCurrent();
  if (beforeCard !== true) return reprice();
  purchaseEvidence.assertCurrent();
  addressCurrent();
  await registry.advance(request.purchaseId, 'arming-payment', {}, now());
  addressCurrent();
  let fill: Awaited<ReturnType<typeof fillCard>>;
  try {
    fill = await fillCard(
      {
        sessionId: identity.sessionId,
        pageId: identity.pageId,
        targets: controls.cardFields,
        expirySeparator: controls.expirySeparator,
        twoDigitYear: controls.twoDigitYear,
      },
      { registry, cards: deps.cards, redactor: deps.redactor, driver, signal, assertCurrent: addressCurrent },
    );
  } catch (error) { await release(); throw error; }
  addressCurrent();
  if (!fill.ok) {
    await release();
    return refused(
      'challenge-abandoned',
      `Refused: the payment form could not be completed (${fill.reason ?? 'the card fields did not accept input'}). `
      + 'Nothing was submitted.',
    );
  }

  // Card entry may itself refresh the checkout. Re-read before journalling a
  // possible submission; the driver's retained observation also guards the
  // actual click after journal flush and all other asynchronous browser checks.
  const beforeSubmit = await verifyTerms.call(driver, expectedTerms, { signal, assertCurrent: addressCurrent });
  addressCurrent();
  if (beforeSubmit !== true) return reprice();

  // ── 9. Journal BEFORE the submit, then submit exactly once ──────────────
  // This flush is what lets a restart tell "not submitted" from "possibly
  // submitted". Everything before it is unambiguously not submitted; from here
  // until a response is seen, we cannot know, and a record in this phase is
  // reported to the owner rather than retried.
  await registry.advance(request.purchaseId, 'submit-pending', {}, now());

  let submission: {
    readonly url: string;
    readonly orderId: string | null;
    readonly challenge?: CheckoutChallenge | null | undefined;
    readonly verified: boolean;
  };
  try {
    const submitCurrent = () => { addressCurrent(); purchaseEvidence.assertCurrent(); addressCurrent(); };
    try { submitCurrent(); } catch { throw new CheckoutSubmitRefused('The original purchase owner, stored address or purchase evidence became unavailable before submission.'); }
    lifecycle.submitMayHaveHappened = true;
    submission = await driver.submitOrder(controls.placeOrderTarget, { assertCurrent: submitCurrent, signal });
  } catch (error) {
    if (error instanceof CheckoutQuoteChanged) {
      lifecycle.submitMayHaveHappened = false;
      return reprice();
    }
    if (error instanceof CheckoutSubmitRefused) {
      lifecycle.submitMayHaveHappened = false;
      // Refused BEFORE the click reached the merchant (a typed refusal, the
      // untrusted-effect guard, a stale ref): nothing was sent, so `release`
      // gives the reservation back and closes the journal rather than
      // holding it against a submit that never happened.
      await release();
      return refused(
        'submit-not-attempted',
        `Refused: the order could not be submitted (${error.message}). Nothing was sent to the merchant.`,
      );
    }
    // Any other throw is genuine ambiguity: the click may have reached the
    // merchant. STAYS submit-pending, budget STAYS reserved, never retried.
    // Not disarmed: whether the click reached the merchant is exactly what is
    // unknown here, so whether the page still shows the card is unknown too.
    // Only actual page or owned-browser closure disarms the page; nothing here
    // claims to know that already happened.
    return refused(
      'challenge-abandoned',
      'The order was submitted but I did not see a response, so I cannot tell whether it went through. '
      + 'Check your order history at this merchant. I will not try again.',
    );
  }

  if (submission.challenge !== undefined && submission.challenge !== null) {
    // 3-D Secure, a CAPTCHA, a one-time code. Pause cleanly and hand the owner the
    // exact step. The reservation is held, because the order may complete once the
    // owner answers, and the record stays in submit-pending for the same reason. NOT
    // disarmed: the owner is about to be sent back to this very page to complete it,
    // so the redactor must still be watching whatever it shows.
    return {
      kind: 'challenge',
      challenge: submission.challenge,
      reason:
        `The merchant asked for an extra verification step before completing this order. `
        + `Nothing further happens until you do it: ${submission.challenge.step}`,
    };
  }

  // Submission alone cannot prove the page no longer contains card material.
  // Only the actual page owner disarms on closure. Keep redaction
  // armed when a non-navigating submit leaves those fields in the DOM.

  // ── 10. Record it ───────────────────────────────────────────────────────
  //
  // The `submitted` phase is flushed AFTER the purchase record is written,
  // never before. A crash anywhere in this section then leaves the journal at
  // `submit-pending`, which recovery reads as possibly-submitted and HOLDS,
  // the safe verdict. Flushing `submitted` first would let a crash strand a
  // real charge with no purchase record while the journal claims it was
  // recorded.
  const atMs = now();
  if (lifecycle.resumedHold) lifecycle.resumedHold.commit(atMs); else ledger.commit(reservation.id, atMs);
  lifecycle.resumedHold = undefined;

  const record: PurchaseRecord = {
    purchaseId: request.purchaseId,
    atUtc: new Date(atMs).toISOString(),
    dayKey: dayKey(atMs, deps.timezone),
    timezone: deps.timezone,
    merchantDomain,
    item: request.item,
    currency: checkout.currency,
    itemMinorUnits: checkout.itemMinorUnits,
    taxMinorUnits: checkout.taxMinorUnits,
    feesMinorUnits: checkout.feesMinorUnits,
    shippingMinorUnits: shipping.costMinorUnits,
    totalMinorUnits: draw.totalMinorUnits,
    ...(requestedMaximumMinorUnits === undefined ? {} : { requestedMaximumMinorUnits }),
    shippingTierRequested: request.preferredTier,
    shippingTierUsed: shipping.tier,
    steppedDown: stepDown !== null,
    itemPoolDraw: draw.itemMinorUnits,
    overagePoolDraw: draw.overageMinorUnits,
    tolerancePoolDraw: draw.toleranceMinorUnits,
    cardLast4,
    windowKind,
    windowOutcome,
    answeredBy,
    // Committed below either way (conservative against a double-spend), but
    // only a composition that read the merchant's own response earns
    // 'purchased'; otherwise the record says so rather than claiming a
    // purchase indistinguishable from a verified one.
    outcome: submission.verified ? 'purchased' : 'submitted-unverified',
    refusalReason: null,
    merchantOrderId: submission.orderId,
    refundedAt: null,
    merchantRecognised: merchantVerdict.isMajor,
    merchantQualifier: merchantVerdict.basis,
    merchantDiscovered: request.merchantDiscovered ?? false,
  };
  await deps.purchases.record(record);
  await registry.advance(request.purchaseId, 'submitted', {}, now());
  await registry.close(request.purchaseId);
  lifecycle.release = undefined;

  // ── 11. Tell the owner it happened ──────────────────────────────────────
  //
  // At charge time, not when the store gets round to emailing. The owner would
  // otherwise get a veto notice, ten minutes of silence, a charge, and nothing,
  // with the store's receipt later landing as mail the owner has to place themself.
  //
  // Sent through the same router as the notice. A delivery failure here is
  // reported and does NOT unwind the purchase: the card has been charged, and
  // an exception thrown after the money moved would leave the ledger and the
  // world disagreeing about whether it did.
  try {
    addressCurrent();
    await notifier.deliver({
      kind: 'veto',
      message: renderPurchaseReport({ facts, merchantOrderId: submission.orderId, verified: submission.verified }),
      signal, assertCurrent: addressCurrent,
    });
  } catch {
    // Nothing to unwind and nothing to retry. The purchase is recorded, and
    // `payments.purchases.list` is the durable answer to "what did you buy".
  }

  return { kind: 'purchased', record, orderId: submission.orderId };
}

/** The merchant identity for a url, computed by us. Null when it has none. */
export function merchantIdentity(url: string): string | null {
  try {
    return registrableDomain(new URL(url).hostname);
  } catch {
    return null;
  }
}
