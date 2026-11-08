/**
 * payments-gateway-service.ts, the daemon side, so the capability is reachable.
 *
 * ══ What was missing ══════════════════════════════════════════════════════
 *
 * `runCheckout` was complete and had no caller. `routes/payments.ts` declared a
 * `PaymentsGatewayService` interface and nothing implemented it. So every piece
 * worked and the daemon had no way to begin a purchase, the chain broke at the
 * point where a request turns into a checkout.
 *
 * This is that link: one service, constructed from the daemon's own managers,
 * behind the `payments.checkout.*` verbs.
 *
 * ══ Everything it needs is injected ═══════════════════════════════════════
 *
 * No manager is reached for from inside. The card store, the address store, the
 * budget ledger, the notifier, the browser driver factory and the clock all
 * arrive through the constructor, for the reason the rest of this capability
 * does the same: the containment assertions have to be able to drive a whole
 * purchase with a sentinel card and then search every output for it, and a
 * service that resolved its own dependencies could only be tested against a
 * real daemon or not at all.
 *
 * ══ The service holds the registry, not the caller ════════════════════════
 *
 * `begin` opens a checkout and `fillCard` completes one, and they are separate
 * verbs arriving as separate control-plane calls. The in-flight registry has to
 * outlive both, so it lives here for the life of the service rather than being
 * constructed per call, which is also what makes "refuse a fill with no
 * decision in flight" enforceable across two independent invocations.
 */
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { BudgetLedger, type BudgetLimits } from './budget.js';
import { requireDecisionFeature } from '../runtime/decision-policy.js';
import { captureOwnedJson } from '../gate/judgment-input.js';
import { captureCheckoutOwnership, CheckoutOwnershipError, type CheckoutOperationOwnership } from './checkout-ownership.js';
import { OwnedWork } from '../utils/owned-work.js';
import { CheckoutRegistry, type CheckoutJournal } from './checkout-registry.js';
import { CardMaterialRedactor } from './card-redaction.js';
import { fillCard, FillCardRefusal, type CardFieldTarget } from './fill-card.js';
import { runCheckout, type CheckoutFlowDeps, type CheckoutControls, type CheckoutOutcome, type PurchaseLedger, type PurchaseRequest } from './checkout-flow.js';
import { extractCheckout, type RawCheckoutReading } from './checkout-extraction.js';
import { parseRequestedMaximum } from './money-parsing.js';
import { isCardFieldName } from './card-material.js';
import { ownerSuppliedText } from './types.js';
import type { AddressFieldName, AddressFieldTarget, AddressStore } from './address.js';

/** The address fields this daemon stores, for validating a wire request. */
const ADDRESS_FIELDS: readonly AddressFieldName[] = [
  'name', 'line1', 'line2', 'city', 'region', 'postalCode', 'country',
];
import type { CardMaterialStore } from './card-material.js';
import type { CheckoutPageDriver } from './checkout-page.js';
import type { GateInput } from './gates.js';
import type { MerchantJudgePort, MerchantPolicy } from './merchant-recourse.js';
import type { PaymentNotifier } from './checkout-flow.js';
import { retainTaintEvidence, type RetainedTaintEvidence, type UntrustedContentLedger } from '../security/untrusted-content.js';
import type { CurrencyCode, ShippingTier } from './types.js';

export { RECOVERY_IO_TIMEOUT_MS } from './checkout-recovery.js';
export type { CheckoutRecoverySweep, InterruptedCheckoutRecovery } from './checkout-recovery.js';
import { CheckoutRecovery, type CheckoutRecoverySweep } from './checkout-recovery.js';

/** What a `payments.checkout.fillCard` call reports. Field names and a boolean. */
export interface PaymentFillCardResult {
  readonly ok: boolean;
  readonly filled: readonly string[];
  readonly failedField: string | null;
  readonly reason: string | null;
}

/** What a `payments.checkout.begin` call reports. */
export interface PaymentBeginResult {
  readonly outcome: string;
  readonly purchaseId: string | null;
  readonly reason: string | null;
  readonly merchantOrderId: string | null;
  readonly totalMinorUnits: number | null;
  readonly currency: string | null;
  readonly shippingTierUsed: string | null;
  readonly steppedDown: boolean;
  /** Set when the merchant interrupted with 3-D Secure, a CAPTCHA or an OTP. */
  readonly challengeStep: string | null;
}

export interface PaymentsServiceConfig {
  readonly limits: BudgetLimits;
  readonly budgetCurrency: CurrencyCode;
  readonly timezone: string;
  readonly preferredTier: ShippingTier;
  readonly approvalMinutes: number;
  readonly vetoMinutes: number;
  readonly merchantPolicy?: MerchantPolicy | undefined;
}

export interface PaymentsServiceDeps {
  readonly cards: CardMaterialStore;
  readonly addresses: AddressStore;
  readonly ledger: BudgetLedger;
  readonly purchases: PurchaseLedger;
  readonly notifier: PaymentNotifier;
  readonly untrusted: UntrustedContentLedger;
  readonly journal: CheckoutJournal;
  /** Judges merchant recourse from the validated domain alone. */
  readonly merchantJudge: MerchantJudgePort;
  /** Resolves the driver for an open browser session and page. */
  readonly driverFor: (sessionId: string, pageId: string) => CheckoutPageDriver;
  /**
   * Composition-supplied cleanup for a page that outlived the process while a
   * checkout was arming the payment. Receives record identity only, never a
   * driver: the composition holds the browser authority and decides whether
   * it can still reach the page (same discipline as the checkout seam, so
   * payments code cannot mint browser access recovery was not given).
   * Resolves true when the card fields were cleared. Absent, recovery keeps
   * the documented posture of refusing to claim a cleanup it cannot perform.
   */
  readonly armingPageCleanup?: ((record: {
    readonly purchaseId: string;
    readonly sessionId: string;
    readonly pageId: string;
  }, options?: CheckoutOperationOwnership) => Promise<boolean>) | undefined;
  /** The gate inputs the daemon alone can answer, leadership most of all. */
  readonly gates: () => GateInput;
  readonly config: () => PaymentsServiceConfig;
  readonly now?: (() => number) | undefined;
  /**
   * Override for `RECOVERY_IO_TIMEOUT_MS`, the per-call ceiling on the
   * sweep's composition I/O. Tests use it; compositions normally do not.
   */
  readonly recoveryIoTimeoutMs?: number | undefined;
  /**
   * The redactor this service arms, supplied rather than minted.
   *
   * Absent, one is constructed here and the service is self-contained, which is
   * what every existing caller and every containment test does. Present, it is
   * the guard the browser engine was built with, and passing the SAME object is
   * the whole point: the engine scrubs page output against what this service
   * armed, and two instances would leave the engine scrubbing an empty set
   * while a card sat on the page. The browser-backed driver refuses rather than
   * types if the two ever come apart (see browser-checkout-driver.ts).
   */
  readonly cardFieldGuard?: CardMaterialRedactor | undefined;
}

/** The input a `begin` call carries, already shape-checked by the route. */
export interface BeginCheckoutInput {
  readonly sessionId: string;
  readonly pageId: string;
  readonly merchantDomain: string;
  readonly checkoutUrl: string;
  readonly item: string;
  readonly cardId: string;
  readonly requestedLines: readonly { readonly label: string; readonly quantity: number }[];
  readonly reading: RawCheckoutReading;
  /**
   * The page controls, in the WIRE shape (`ref`), translated below.
   *
   * The wire says `ref` because that is what a snapshot calls an element; the
   * flow says `target` because it has no opinion about what an addressing
   * string is. Translating here, explicitly, rather than by casting, is what
   * keeps a mismatch a compile error instead of a runtime refusal that reads
   * like a missing address.
   */
  readonly controls: {
    readonly cardFields: readonly { readonly field: string; readonly ref: string }[];
    readonly addressFields?: readonly { readonly kind: string; readonly field: string; readonly ref: string }[] | undefined;
    readonly shippingTargets?: readonly string[] | undefined;
    readonly placeOrderTarget: string;
    readonly expirySeparator?: string | undefined;
    readonly twoDigitYear?: boolean | undefined;
  };
  readonly preferredTier?: ShippingTier | undefined;
  readonly requestedMax?: string | undefined;
  /** True when the storefront was found while browsing rather than named. */
  readonly merchantDiscovered?: boolean | undefined;
}

/** Host-only invocation facts; never read from the checkout's wire input. */
export interface CheckoutBeginOptions extends CheckoutOperationOwnership {
  readonly retainWindowCheckpoint?: CheckoutFlowDeps['retainWindowCheckpoint'];
  /** Original request's host-captured sources, retained before async preflight. */
  readonly taintEvidence?: RetainedTaintEvidence | undefined;
  readonly gates?: GateInput | undefined;
  /** Native operation identity assigned before background work starts. */
  readonly purchaseId?: string | undefined;
}

export class PaymentsGatewayServiceImpl {
  private readonly registry: CheckoutRegistry;
  private readonly redactor: CardMaterialRedactor;
  private readonly recovery: CheckoutRecovery;
  private readonly work = new OwnedWork();
  private readonly abort = new AbortController();
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(private readonly deps: PaymentsServiceDeps, registry?: CheckoutRegistry) {
    this.deps = { ...deps };
    this.registry = registry ?? new CheckoutRegistry(deps.journal);
    this.redactor = deps.cardFieldGuard ?? new CardMaterialRedactor();
    this.recovery = new CheckoutRecovery({ registry: this.registry, journal: deps.journal,
      ledger: deps.ledger, purchases: deps.purchases, notifier: deps.notifier,
      isPaymentsLeader: () => this.deps.gates().isPaymentsLeader, now: deps.now,
      armingPageCleanup: deps.armingPageCleanup, recoveryIoTimeoutMs: deps.recoveryIoTimeoutMs });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.closing = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    this.closed = true;
    this.abort.abort(new CheckoutOwnershipError());
    void Promise.all([this.work.join(), this.recovery.close()]).then(() => resolve(), reject);
    return this.closing;
  }

  private ownership(options: CheckoutOperationOwnership) {
    if (this.closed) throw new CheckoutOwnershipError();
    const owner = captureCheckoutOwnership(options);
    const signal = owner.signal ? AbortSignal.any([owner.signal, this.abort.signal]) : this.abort.signal;
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (this.closed) throw new CheckoutOwnershipError();
      owner.assertCurrent();
      signal.throwIfAborted();
    };
    assertCurrent();
    return { signal, assertCurrent };
  }

  /**
   * The redactor this service types cards through.
   *
   * Exposed so the daemon can hand the SAME instance to the browser engine as
   * its `cardFieldGuard`. They must be one object: the engine scrubs against
   * what this service armed, and two instances would mean the engine scrubbing
   * against an empty set while a card sat on the page.
   */
  cardFieldGuard(): CardMaterialRedactor {
    return this.redactor;
  }

  /**
   * Begin and run a checkout.
   *
   * Everything the flow needs that only the daemon knows, the limits, the
   * timezone, the leadership answer, is read HERE, at the moment of the call,
   * rather than captured at construction. A budget raised five minutes ago
   * should apply to this purchase.
   */
  async beginCheckout(input: BeginCheckoutInput, options: CheckoutBeginOptions = {}): Promise<PaymentBeginResult> {
    if (this.closed) throw new CheckoutOwnershipError();
    const purchaseId = options.purchaseId;
    const retainWindowCheckpoint = options.retainWindowCheckpoint?.bind(options);
    const gates = { ...(options.gates ?? this.deps.gates()) };
    const owner = this.ownership(options);
    owner.assertCurrent?.();
    const taintEvidence = options.taintEvidence === undefined ? retainTaintEvidence(this.deps.untrusted)
      : captureOwnedJson(options.taintEvidence) as RetainedTaintEvidence;
    return this.work.run(() => this.runBeginCheckout(input, owner, gates, purchaseId, taintEvidence, retainWindowCheckpoint));
  }

  private async runBeginCheckout(input: BeginCheckoutInput, options: CheckoutOperationOwnership, gates: GateInput, purchaseId: string | undefined, taintEvidence: RetainedTaintEvidence,
    retainWindowCheckpoint?: CheckoutFlowDeps['retainWindowCheckpoint']): Promise<PaymentBeginResult> {
    requireDecisionFeature('automated checkout cart and merchant interpretation');
    const config = this.deps.config();
    const now = this.deps.now ?? Date.now;
    options.assertCurrent?.();
    if (input.requestedMax !== undefined && parseRequestedMaximum(input.requestedMax, config.budgetCurrency) === null) {
      return { ...this.refused('The requested maximum must be one non-negative decimal amount in the budget currency, without grouping or prose.'), purchaseId: purchaseId ?? null };
    }
    try {
      const available: unknown = this.deps.purchases.assertAvailable?.();
      if (available !== undefined) { drainOwned(available); throw new CheckoutOwnershipError(); }
    } catch (error) { drainOwned(error); throw error; }
    options.assertCurrent?.();

    // The item is the OWNER's words. `ownerSuppliedText` refuses anything not
    // from an owner-direct turn, and a null here is a refusal rather than a
    // cast: the branded type is what stops page text reaching their phone.
    const item = ownerSuppliedText(input.item, 'owner-direct');
    if (item === null) {
      return { ...this.refused('The item has to be described in your own words, from your own request.'), purchaseId: purchaseId ?? null };
    }

    const driver = this.deps.driverFor(input.sessionId, input.pageId);
    options.assertCurrent?.();
    const request: PurchaseRequest = {
      purchaseId: purchaseId ?? `pur-${String(now())}-${Math.random().toString(36).slice(2, 10)}`,
      merchantDomain: input.merchantDomain,
      checkoutUrl: input.checkoutUrl,
      item,
      requestedLines: input.requestedLines,
      cardId: input.cardId,
      preferredTier: input.preferredTier ?? config.preferredTier,
      requestedMax: input.requestedMax,
      merchantDiscovered: input.merchantDiscovered ?? false,
    };

    const cardFields: CardFieldTarget[] = [];
    for (const entry of input.controls.cardFields) {
      if (!isCardFieldName(entry.field)) {
        return { ...this.refused(`"${entry.field}" is not a card field I can fill.`), purchaseId: request.purchaseId };
      }
      cardFields.push({ field: entry.field, target: entry.ref });
    }

    const addressFields: AddressFieldTarget[] = [];
    for (const entry of input.controls.addressFields ?? []) {
      if (entry.kind !== 'shipping' && entry.kind !== 'billing') {
        return { ...this.refused(`"${entry.kind}" is not an address I hold. Use shipping or billing.`), purchaseId: request.purchaseId };
      }
      if (!ADDRESS_FIELDS.includes(entry.field as AddressFieldName)) {
        return { ...this.refused(`"${entry.field}" is not part of an address I store.`), purchaseId: request.purchaseId };
      }
      addressFields.push({ kind: entry.kind, field: entry.field as AddressFieldName, target: entry.ref });
    }

    const controls: CheckoutControls = {
      cardFields,
      addressFields,
      shippingTargets: input.controls.shippingTargets ?? [],
      placeOrderTarget: input.controls.placeOrderTarget,
      expirySeparator: input.controls.expirySeparator,
      twoDigitYear: input.controls.twoDigitYear,
    };

    const outcome = await runCheckout(request, input.reading, controls, {
      retainWindowCheckpoint,
      signal: options.signal,
      assertCurrent: options.assertCurrent,
      registry: this.registry,
      cards: this.deps.cards,
      addresses: this.deps.addresses,
      redactor: this.redactor,
      driver,
      ledger: this.deps.ledger,
      purchases: this.deps.purchases,
      notifier: this.deps.notifier,
      untrusted: this.deps.untrusted,
      taintEvidence,
      merchantJudge: this.deps.merchantJudge,
      merchantPolicy: config.merchantPolicy,
      limits: config.limits,
      budgetCurrency: config.budgetCurrency,
      timezone: config.timezone,
      gates,
      approvalMinutes: config.approvalMinutes,
      vetoMinutes: config.vetoMinutes,
      now,
    });

    return this.describe(outcome, request.purchaseId);
  }

  recoverInterruptedCheckouts(): Promise<CheckoutRecoverySweep> {
    return this.recovery.recoverInterruptedCheckouts();
  }

  /**
   * Type the stored card into an open checkout.
   *
   * The refusals live in `fillCard`; this only adapts the shapes. A
   * `FillCardRefusal` is rethrown so the route can forward its message, it
   * carries no card material and it is the owner's business why the fill was
   * refused.
   */
  async fillCardIntoCheckout(input: {
    readonly sessionId: string;
    readonly pageId: string;
    readonly targets: readonly { readonly field: string; readonly ref: string }[];
    readonly expirySeparator: string | undefined;
    readonly twoDigitYear: boolean | undefined;
  }, options: CheckoutOperationOwnership = {}): Promise<PaymentFillCardResult> {
    const owner = this.ownership(options);
    return this.work.run(() => this.runFillCard(input, owner));
  }

  private async runFillCard(input: Parameters<PaymentsGatewayServiceImpl['fillCardIntoCheckout']>[0],
    owner: ReturnType<PaymentsGatewayServiceImpl['ownership']>): Promise<PaymentFillCardResult> {
    const signal = owner.signal;
    const targets: CardFieldTarget[] = [];
    for (const entry of input.targets) {
      if (!isCardFieldName(entry.field)) {
        throw new FillCardRefusal(
          `"${entry.field}" is not a card field I can fill.`,
          'Name one of: number, expiry, expiryMonth, expiryYear, cvv, cardholderName.',
        );
      }
      targets.push({ field: entry.field, target: entry.ref });
    }

    const result = await fillCard(
      {
        sessionId: input.sessionId,
        pageId: input.pageId,
        targets,
        expirySeparator: input.expirySeparator,
        twoDigitYear: input.twoDigitYear,
      },
      {
        registry: this.registry,
        cards: this.deps.cards,
        redactor: this.redactor,
        driver: this.deps.driverFor(input.sessionId, input.pageId),
        signal,
        assertCurrent: owner.assertCurrent,
      },
    );
    return {
      ok: result.ok,
      filled: [...result.filled],
      failedField: result.failedField,
      reason: result.reason,
    };
  }

  /** Validate a reading without buying anything, so a caller can check its parse. */
  previewReading(reading: RawCheckoutReading): { ok: boolean; reason: string | null } {
    const config = this.deps.config();
    const extraction = extractCheckout(reading, config.budgetCurrency);
    return extraction.ok ? { ok: true, reason: null } : { ok: false, reason: extraction.reason };
  }

  private refused(reason: string): PaymentBeginResult {
    return {
      outcome: 'refused',
      purchaseId: null,
      reason,
      merchantOrderId: null,
      totalMinorUnits: null,
      currency: null,
      shippingTierUsed: null,
      steppedDown: false,
      challengeStep: null,
    };
  }

  private describe(outcome: CheckoutOutcome, purchaseId: string): PaymentBeginResult {
    if (outcome.kind === 'refused') {
      return { ...this.refused(outcome.reason), purchaseId, outcome: `refused:${outcome.code}` };
    }
    if (outcome.kind === 'cancelled') {
      return { ...this.refused(outcome.reason), purchaseId, outcome: 'cancelled' };
    }
    if (outcome.kind === 'challenge') {
      return {
        outcome: `challenge:${outcome.challenge.kind}`,
        purchaseId,
        reason: outcome.reason,
        merchantOrderId: null,
        totalMinorUnits: null,
        currency: null,
        shippingTierUsed: null,
        steppedDown: false,
        challengeStep: outcome.challenge.step,
      };
    }
    return {
      // The record's own outcome carries the verified/unverified truth
      // (checkout-flow.ts); forwarded rather than hardcoded so a caller with
      // no describeSubmission wired sees "submitted-unverified" instead of a
      // claim indistinguishable from a confirmed purchase.
      outcome: outcome.record.outcome,
      purchaseId: outcome.record.purchaseId,
      reason: null,
      merchantOrderId: outcome.record.merchantOrderId,
      totalMinorUnits: outcome.record.totalMinorUnits,
      currency: outcome.record.currency,
      shippingTierUsed: outcome.record.shippingTierUsed,
      steppedDown: outcome.record.steppedDown,
      challengeStep: null,
    };
  }
}
