import { readCheckoutReadingInput } from '../checkout-reading-input.js';
import { PostalAddressHeldError } from '../../config/postal-address.js';
import { mapLimit } from '@goodvibes-jev/judgment';
import { retainCheckoutInvocation, retainDetachedCheckout } from './checkout-invocation.js';
import { PaymentCheckoutJournalUnavailableError } from './checkout-journal-store.js';
import { PaymentPurchaseLedgerError } from './purchase-ledger.js';
import { captureCheckoutOwnership, CheckoutOwnershipError, type CheckoutOperationOwnership } from '../checkout-ownership.js';
import { OwnedWork } from '../../utils/owned-work.js';
import { CheckoutOperations, type DetachedCheckoutOwner, type DetachedCheckoutSource } from './checkout-operations.js';
import { PaymentOperationStoreError, checkoutRequestId, type DurablePaymentOperations } from './operation-store.js';
import type { BeginCheckoutInput } from '../payments-gateway-service.js';
import { ProtectedPaymentRequestError, type PaymentRequestStore, type ProtectedPaymentRequest } from './protected-requests.js';
import type { CheckoutWindowResumption } from '../checkout-window-checkpoint.js';
import type { CheckoutPageDriver } from '../checkout-page.js';
import { retainResumedCheckoutHold } from '../resumed-hold.js';
import { isDeepStrictEqual } from 'node:util';
import type { NativeContinuationGrant } from '../../pairing/pairing-token-store.js';
import { BrowserPageConnectionError } from '../../browser/browser-page-connection-data.js';
import { PurchaseReconciliations } from './purchase-reconciliation.js';
/**
 * checkout-handlers.ts, `payments.checkout.begin` / `payments.checkout.fillCard`.
 *
 * Split out of register.ts for the 800-line file cap, the same reason
 * daemon-handler-composition.ts/ci-watch-composition.ts exist as their own
 * modules; no behavioural change from being here rather than there.
 *
 * ── Why these verbs are local wrappers, not the platform's own route ────────
 *
 * `registerPaymentsGatewayMethods`'s own `createPaymentsCheckoutBeginHandler`/
 * `createPaymentsCheckoutFillCardHandler` call
 * `service.beginCheckout(input)`/`service.fillCardIntoCheckout(input)` with no
 * invocation context at all. Admission here needs `context.explicitUserRequest`
 * and the paired principal, which only reach a handler attached through this
 * daemon's own `registerCatalogHandlers` (register.ts). So the verbs are
 * attached there as local wrappers, reading the same wire shapes
 * `routes/payments.ts` does and calling into the ONE
 * `PaymentsGatewayServiceImpl` a registration's checkout pair shares for its
 * whole life (see `CheckoutServiceHolder` below for why one, not one per call).
 */
import { checkAddress } from '../address.js';
import type { GateInput } from '../gates.js';
import type { AddressStore } from '../address.js';
import { CheckoutRegistry } from '../checkout-registry.js';
import { CheckoutRecovery } from '../checkout-recovery.js';
import type { CheckoutJournal, InFlightCheckout } from '../checkout-registry.js';
import type { MerchantJudgePort } from '../merchant-recourse.js';
import type { PaymentNotifier } from '../payment-ports.js';
import type { PaymentReplyInbox } from '../reply-inbox.js';
import { PaymentsGatewayServiceImpl } from '../payments-gateway-service.js';
import { readConfirmEveryPurchase, readCvvHandling, readDefaultCardId, readPaymentsEnabled, readPaymentsServiceConfig } from '../payments-config.js';
import { minorUnitExponent, parseRequestedMaximum } from '../money-parsing.js';
import { registrableDomain } from '../../security/public-suffix.js';
import { paymentHostStop, PaymentHostStoppedError, type PaymentStoreHealth, type PaymentStoreStop } from '../payment-host-health.js';
import type { CurrencyCode } from '../types.js';
import type { SecurityCodeRequests } from '../security-code-requests.js';
import { SHIPPING_TIERS } from '../types.js';
import type { ShippingTier } from '../types.js';
import type { UntrustedContentLedger } from '../../security/untrusted-content.js';
import type { BrowserCheckoutSeam } from '../../control-plane/routes/browser-composition.js';
import { HandlerError } from './handler-plumbing.js';
import type { TypedHandler } from './handler-plumbing.js';
import { PaymentApprovalStoreError, type DaemonApprovalStore } from './approval-store.js';
import type { DaemonCardStore } from './card-store.js';
import type { PaymentsHandlerDeps } from './register.js';

/**
 * Everything the checkout pair needs beyond what the other five verbs use.
 *
 * Built by runtime/payments-composition.ts and handed here as one bundle
 * because every field is checkout-only: nothing else in register.ts reads an
 * address, sends a notice, judges a merchant, or reads the untrusted-content
 * ledger.
 */
export interface CheckoutComposition {
  /**
   * The browser-checkout seam, once `onBrowserCheckout` has fired.
   *
   * A GETTER, not a cached value: the native graph installs its browser seam
   * before payment handlers are acquired, while narrow embedders may omit it.
   * Calls retain the exact serving seam and refuse if the getter changes.
   * Undefined never authorizes creating a replacement browser from saved data.
   */
  readonly seam: () => BrowserCheckoutSeam | undefined;
  readonly addresses: AddressStore;
  readonly notifier: PaymentNotifier;
  /** The exact daemon-owned inbox also borrowed by channel reply ingress. */
  readonly replies?: PaymentReplyInbox | undefined;
  /**
   * Where a purchase under `payments.cvvHandling: 'prompt'` waits for the code
   * the owner types (`payments.purchase.securityCode`). Absent, prompt mode
   * refuses purchases on this host and says why.
   */
  readonly securityCodes?: SecurityCodeRequests | undefined;
  readonly merchantJudge: MerchantJudgePort;
  /** The process-wide ledger; see routes/browser-composition.ts's header for why it must be shared, not private. */
  readonly untrusted: UntrustedContentLedger;
  /**
   * The persisted, single-use approvals `payments.checkout.approve` mints and
   * `payments.checkout.begin` spends. See approval-store.ts for the four
   * properties the store keeps, and `checkoutBeginHandler` below for where
   * one is consumed.
   */
  readonly approvals: DaemonApprovalStore;
  /**
   * The journal the shared service's in-flight registry writes through. The
   * real daemon composes `DurableCheckoutJournal`
   * (checkout-journal-store.ts) so a `submit-pending` record survives a
   * restart; tests may compose the platform's `MemoryCheckoutJournal`.
   */
  readonly journal: CheckoutJournal;
  readonly operations: DurablePaymentOperations;
  /** Native composition stores original facts before acknowledging admission. */
  readonly requests?: PaymentRequestStore | undefined;
  /** Construction-only native restoration. Saved JSON cannot supply this
   * callback or independently authorize its browser/paired-owner work. */
  readonly restoreWindow?: ((request: ProtectedPaymentRequest, owner: DetachedCheckoutOwner) => Promise<RestoredCheckoutWindow>) | undefined;
  readonly retireContinuation?: ((grant: NativeContinuationGrant) => void) | undefined;
}

export interface RestoredCheckoutWindow {
  readonly source: DetachedCheckoutSource;
  readonly input: BeginCheckoutInput;
  readonly resumption: CheckoutWindowResumption;
  readonly driver: CheckoutPageDriver;
  release(): Promise<void>;
}

function invalid(field: string, requirement: string): HandlerError {
  return new HandlerError(`${field} ${requirement}`, 'INVALID_ARGUMENT', 400);
}

function asRecord(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw invalid(field, 'is required.');
  return value.trim();
}

function requireWholeNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw invalid(field, 'must be a whole number.');
  return value;
}

/** A requested line is at least one of something; the protected request store refuses anything less. */
function requireQuantity(value: unknown, field: string): number {
  const quantity = requireWholeNumber(value, field);
  if (quantity < 1) throw invalid(field, 'must be a whole number of at least 1.');
  return quantity;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Deliberately STRICTER than the platform's own route (routes/payments.ts), which
 * passes any non-empty `preferredTier` string through unvalidated. This is a
 * deliberate pin, not an oversight relative to that route: a value outside
 * `SHIPPING_TIERS` could not have come from a tier this daemon actually
 * offers, so it is read as "not specified" rather than forwarded, and
 * `beginCheckout` falls back to the configured preferred tier when this is
 * undefined (payments-gateway-service.ts), the same safe default an absent
 * field already gets.
 */
function optionalShippingTier(value: unknown): ShippingTier | undefined {
  return typeof value === 'string' && (SHIPPING_TIERS as readonly string[]).includes(value)
    ? (value as ShippingTier)
    : undefined;
}

function readObjectRows(value: unknown, field: string, required: boolean): Record<string, unknown>[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || (required && value.length === 0)) {
    throw invalid(field, 'is required and must be a non-empty array.');
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw invalid(`${field}[${String(index)}]`, 'must be an object.');
    }
    return entry as Record<string, unknown>;
  });
}

function readStringRows(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(field, 'must be an array of strings.');
  return value.map((entry, index) => requireString(entry, `${field}[${String(index)}]`));
}

/** What the begin parser needs from settings: amounts are read in the budget currency, and an unnamed card is the default one. */
interface BeginInputSettings { readonly budgetCurrency: CurrencyCode; readonly defaultCardId: string }

/** The exact shape `PaymentsGatewayServiceImpl.beginCheckout` wants, read off the wire. */
function parseBeginCheckoutInput(params: Record<string, unknown>, settings: BeginInputSettings): Parameters<PaymentsGatewayServiceImpl['beginCheckout']>[0] {
  const requestedLines = readObjectRows(params['requestedLines'], 'requestedLines', true).map((entry, index) => ({
    label: requireString(entry['label'], `requestedLines[${String(index)}].label`),
    quantity: requireQuantity(entry['quantity'], `requestedLines[${String(index)}].quantity`),
  }));
  const lines = readObjectRows(params['lines'], 'lines', true).map((entry, index) => ({
    label: requireString(entry['label'], `lines[${String(index)}].label`),
    quantity: requireString(entry['quantity'], `lines[${String(index)}].quantity`),
    unitPrice: requireString(entry['unitPrice'], `lines[${String(index)}].unitPrice`),
  }));
  const fees = readObjectRows(params['fees'], 'fees', false).map((entry, index) => ({
    label: requireString(entry['label'], `fees[${String(index)}].label`),
    amount: requireString(entry['amount'], `fees[${String(index)}].amount`),
  }));
  const shippingOptions = readObjectRows(params['shippingOptions'], 'shippingOptions', true).map((entry, index) => ({
    label: requireString(entry['label'], `shippingOptions[${String(index)}].label`),
    cost: requireString(entry['cost'], `shippingOptions[${String(index)}].cost`),
  }));
  const cardFields = readObjectRows(params['cardFields'], 'cardFields', true).map((entry, index) => ({
    field: requireString(entry['field'], `cardFields[${String(index)}].field`),
    ref: requireString(entry['ref'], `cardFields[${String(index)}].ref`),
  }));
  const addressFields = readObjectRows(params['addressFields'], 'addressFields', false).map((entry, index) => ({
    kind: requireString(entry['kind'], `addressFields[${String(index)}].kind`),
    field: requireString(entry['field'], `addressFields[${String(index)}].field`),
    ref: requireString(entry['ref'], `addressFields[${String(index)}].ref`),
  }));
  const twoDigit = params['twoDigitYear'];
  // The same bounds the protected request store enforces on the retained copy.
  // Checked here, before the owner's approval is spent, so a malformed reading
  // is refused by name and does not leave a failed purchase behind.
  const reading = {
    lines,
    tax: optionalNonEmptyString(params['tax']) ?? null,
    fees,
    shippingOptions,
    statedTotal: optionalNonEmptyString(params['statedTotal']) ?? null,
    currency: optionalNonEmptyString(params['currency']) ?? null,
    orderSummaryText: typeof params['orderSummaryText'] === 'string' ? params['orderSummaryText'] : '',
  };
  const checkedReading = readCheckoutReadingInput(reading);
  if (!checkedReading.ok) throw new HandlerError(`${checkedReading.field}: ${checkedReading.reason}`, 'INVALID_ARGUMENT', 400);
  const requestedMax = params['requestedMax'] === undefined ? undefined : requireString(params['requestedMax'], 'requestedMax');
  if (requestedMax !== undefined && parseRequestedMaximum(requestedMax, settings.budgetCurrency) === null) {
    throw invalid('requestedMax', `must be a plain amount in ${settings.budgetCurrency} such as ${plainAmountExample(settings.budgetCurrency)}.`);
  }
  // A purchase that names no card is paid with the owner's default card.
  const defaultCard = settings.defaultCardId.trim();
  if (params['cardId'] === undefined && defaultCard.length === 0) {
    throw invalid('cardId', 'is required: name a card from payments.cards.list, or set payments.defaultCardId.');
  }
  const cardId = params['cardId'] === undefined ? defaultCard : requireString(params['cardId'], 'cardId');
  const discovered = params['merchantDiscovered'];
  if (discovered !== undefined && typeof discovered !== 'boolean') throw invalid('merchantDiscovered', 'must be true or false.');
  return {
    sessionId: requireString(params['sessionId'], 'sessionId'),
    pageId: requireString(params['pageId'], 'pageId'),
    merchantDomain: requireString(params['merchantDomain'], 'merchantDomain'),
    checkoutUrl: requireString(params['checkoutUrl'], 'checkoutUrl'),
    item: requireString(params['item'], 'item'),
    cardId,
    requestedLines,
    reading,
    controls: {
      cardFields,
      addressFields,
      shippingTargets: readStringRows(params['shippingTargets'], 'shippingTargets'),
      placeOrderTarget: requireString(params['placeOrderTarget'], 'placeOrderTarget'),
      expirySeparator: optionalNonEmptyString(params['expirySeparator']),
      twoDigitYear: typeof twoDigit === 'boolean' ? twoDigit : undefined,
    },
    preferredTier: optionalShippingTier(params['preferredTier']),
    requestedMax,
    // Read as sent. True only moves the merchant and checkout url from the
    // taint check to the recourse judge (taint-gate.ts, merchant-recourse.ts),
    // and a merchant nobody vouches for turns the window into an approval that
    // silence denies, so the flag can never make spending more automatic.
    // The item and any stated maximum are taint-checked either way.
    merchantDiscovered: discovered === true,
  };
}

function plainAmountExample(currency: CurrencyCode): string {
  const exponent = minorUnitExponent(currency);
  return exponent === 0 ? '2500' : `25 or 25.${'0'.repeat(exponent)}`;
}

/** The exact shape `PaymentsGatewayServiceImpl.fillCardIntoCheckout` wants, read off the wire. */
function parseFillCardInput(params: Record<string, unknown>): Parameters<PaymentsGatewayServiceImpl['fillCardIntoCheckout']>[0] {
  const rawTargets = params['targets'];
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
    throw invalid('targets', 'is required: name each card field you found and the ref to type it into.');
  }
  const targets = rawTargets.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw invalid(`targets[${String(index)}]`, 'must be an object.');
    }
    const record = entry as Record<string, unknown>;
    return {
      field: requireString(record['field'], `targets[${String(index)}].field`),
      ref: requireString(record['ref'], `targets[${String(index)}].ref`),
    };
  });
  // Deliberately a plain `typeof` check, not `optionalNonEmptyString`: the
  // platform's own fillCard route (routes/payments.ts) keeps an EMPTY separator
  // distinct from an ABSENT one (a caller that says "" is asking for the
  // digits run together, `0729`, and one that says nothing gets the default
  // `/`), and `optionalNonEmptyString` would collapse both to `undefined`.
  // `parseBeginCheckoutInput`'s own `expirySeparator` field stays on
  // `optionalNonEmptyString`, matching the platform's begin route instead, which
  // does the same collapse there.
  const separator = params['expirySeparator'];
  return {
    sessionId: requireString(params['sessionId'], 'sessionId'),
    pageId: requireString(params['pageId'], 'pageId'),
    targets,
    expirySeparator: typeof separator === 'string' ? separator : undefined,
    twoDigitYear: typeof params['twoDigitYear'] === 'boolean' ? params['twoDigitYear'] : undefined,
  };
}

/**
 * Allowlisted, the same reason `sanitizeFillResult` exists in the platform's own
 * route module: a service bug becomes a missing field here, never a leaked
 * one, and this wrapper bypasses that route entirely, so it is this file's job
 * to keep the property.
 */
function fillCardResultView(result: Awaited<ReturnType<PaymentsGatewayServiceImpl['fillCardIntoCheckout']>>): Record<string, unknown> {
  return {
    ok: result.ok === true,
    filled: (result.filled ?? []).map((field) => String(field)),
    failedField: result.failedField === null || result.failedField === undefined ? null : String(result.failedField),
    reason: result.reason === null || result.reason === undefined ? null : String(result.reason),
  };
}

/**
 * Whether the named card can actually be charged: configured, and its
 * material present in the secret store. Computed here, outside
 * `PaymentsGatewayServiceImpl`, because `GateInput` is a plain synchronous
 * record and this daemon's card-material check is async.
 */
async function hasUsableCard(cards: DaemonCardStore, cardId: string, owner: CheckoutOperationOwnership, securityCodePrompt = false): Promise<boolean> {
  owner.assertCurrent?.();
  if (cardId.length === 0) return false;
  const metadata = await cards.metadata(cardId);
  owner.assertCurrent?.();
  if (metadata === null) return false;
  const complete = securityCodePrompt ? await cards.materialCompleteExceptCvv(cardId) : await cards.materialComplete(cardId);
  owner.assertCurrent?.();
  return complete;
}

/** Same reasoning as `hasUsableCard`: an async read, resolved before `GateInput` is built. */
async function hasShippingAddress(addresses: AddressStore, owner: CheckoutOperationOwnership): Promise<boolean> {
  try {
    owner.assertCurrent?.();
    const stored = await addresses.read('shipping', { signal: owner.signal });
    owner.assertCurrent?.();
    return checkAddress(stored, 'shipping').ok;
  } catch (error) {
    if (error instanceof PostalAddressHeldError) throw new HandlerError(error.message, 'FAILED_PRECONDITION', 409);
    throw error;
  }
}

/**
 * Build the ONE `PaymentsGatewayServiceImpl` a registration's checkout pair
 * shares for its whole life. See `CheckoutServiceHolder` for why one, not one
 * per call.
 */
function buildCheckoutService(
  deps: PaymentsHandlerDeps,
  seam: BrowserCheckoutSeam,
  journal: CheckoutJournal,
  registry: CheckoutRegistry,
): PaymentsGatewayServiceImpl {
  return new PaymentsGatewayServiceImpl({
    cards: deps.cards,
    addresses: deps.checkout.addresses,
    ledger: deps.budget,
    purchases: deps.purchases,
    notifier: deps.checkout.notifier,
    untrusted: deps.checkout.untrusted,
    journal,
    merchantJudge: deps.checkout.merchantJudge,
    ...(deps.checkout.securityCodes ? { securityCodes: deps.checkout.securityCodes } : {}),
    driverFor: seam.driverFor,
    cardFieldGuard: seam.cardFieldGuard,
    gates: () => ({
      enabled: readPaymentsEnabled(deps.config),
      isPaymentsLeader: deps.isPaymentsLeader(),
      hasUsableCard: false, hasShippingAddress: false, isOwnerDirectRequest: false,
    }),
    config: () => readPaymentsServiceConfig(deps.config),
    ...(deps.now ? { now: deps.now } : {}),
  }, registry);
}

/** Owns the registration's registry before a browser exists. Boot recovery
 * and the lazy browser service share that same registry, so recovery never
 * mistakes a live operation for an interrupted one. Invocation gate facts are
 * passed directly to beginCheckout, without a shared mutable cell.
 * close stops admission and drains preflight, browser and recovery work before
 * a replacement registration may use the stores and catalog. */
export class CheckoutServiceHolder {
  private service: PaymentsGatewayServiceImpl | null = null;
  private readonly registry: CheckoutRegistry;
  private readonly recovery: CheckoutRecovery;
  readonly operations: CheckoutOperations;
  readonly reconciliations: PurchaseReconciliations;
  private readonly work = new OwnedWork();
  private readonly abort = new AbortController();
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly restoreWindow: CheckoutComposition['restoreWindow'];
  private windowsRetained = false;
  private readonly retireContinuation: CheckoutComposition['retireContinuation'];

  constructor(
    private readonly deps: PaymentsHandlerDeps,
    private readonly journal: CheckoutJournal,
  ) {
    this.restoreWindow = deps.checkout.restoreWindow?.bind(deps.checkout);
    this.retireContinuation = deps.checkout.retireContinuation?.bind(deps.checkout);
    const notifier = deps.checkout.notifier;
    this.operations = new CheckoutOperations(deps.checkout.operations, journal, deps.purchases,
      (input, id, owner) => this.runAdmittedCheckout(input, id, owner), deps.now, deps.checkout.requests, deps.checkout.replies,
      { notify: async message => { await notifier.deliver({ kind: 'notice', message }); }, retire: this.retireContinuation });
    // A reconciled purchase's journal record is removed outside the registry;
    // its page must not stay claimed by that settled purchase until restart.
    const reconciliationJournal: CheckoutJournal = Object.freeze({ list: () => journal.list(), put: (record: InFlightCheckout) => journal.put(record),
      remove: async (id: string) => {
        await journal.remove(id);
        try { await this.registry.forgetRemoved(id); } catch { /* The page is freed on restart instead. */ }
      } });
    this.reconciliations = new PurchaseReconciliations({ operations: deps.checkout.operations, journal: reconciliationJournal,
      purchases: deps.purchases, budget: deps.budget, isPaymentsLeader: deps.isPaymentsLeader, now: deps.now,
      settled: (purchaseId, operationId) => this.operations.settledElsewhere(purchaseId, operationId) });
    this.registry = new CheckoutRegistry({ list: () => journal.list(),
      remove: async id => { await journal.remove(id); this.operations.released(id); },
      put: async record => { await journal.put(record); this.operations.progress(record); } });
    this.recovery = new CheckoutRecovery({ registry: this.registry, journal,
      ledger: deps.budget, purchases: deps.purchases, notifier: deps.checkout.notifier,
      retainInterrupted: id => deps.checkout.operations.get(id)?.outcome?.startsWith('owner-reconciliation-pending-')
        ? null : deps.checkout.operations.retainRecovery(id),
      isPaymentsLeader: deps.isPaymentsLeader, now: deps.now });
  }

  serviceFor(seam: BrowserCheckoutSeam): PaymentsGatewayServiceImpl {
    if (this.closed) throw new HandlerError('Checkout service is closed.', 'FAILED_PRECONDITION', 409);
    this.service ??= buildCheckoutService(this.deps, seam, this.journal, this.registry);
    return this.service;
  }

  async recoverInterruptedCheckouts() {
    if (this.deps.isPaymentsLeader()) await this.reconciliations.recover();
    if (this.restoreWindow && !this.windowsRetained && this.deps.isPaymentsLeader()) {
      await this.operations.retainInterruptedWindows((request, current) => {
        if (!request.window) throw new CheckoutOwnershipError();
        const checkpoint = request.window, hold = retainResumedCheckoutHold(this.deps.budget, checkpoint.record);
        return async () => {
          current(); const records = await this.journal.list(); current();
          if (!isDeepStrictEqual(records.find(record => record.purchaseId === request.purchaseId), checkpoint.record)) return false;
          // This is original pre-submit evidence cleanup, not permission to
          // execute. It must remain possible after cancellation/revocation.
          hold.assertCurrent(); hold.release(); current();
          await this.journal.remove(request.purchaseId); current();
          if (request.host.continuation) this.retireContinuation?.(request.host.continuation);
          return true;
        };
      }); this.windowsRetained = true;
    }
    const sweep = await this.recovery.recoverInterruptedCheckouts();
    if (sweep.swept) {
      await this.operations.recover();
      // Requests of purchases that ended (by any route, including a crash) go
      // now; windows being resumed were retained above and are kept.
      try { await this.operations.sweepSettledRequests(); }
      catch { /* A request that cannot be judged stays for the next start. */ }
      const restore = this.restoreWindow;
      if (restore) this.operations.resumeInterruptedWindows(async (request, owner) => {
        const restored = await restore(request, owner);
        // All cleanup belongs to the executor even if restoration succeeded
        // just as the registration retired. The executor releases on failure.
        return Object.freeze({ source: restored.source, input: restored.input,
          release: restored.release.bind(restored),
          execute: async (input: BeginCheckoutInput, id: string, current: DetachedCheckoutOwner) => {
            current.assertCurrent();
            const seam = this.deps.checkout.seam(); if (!seam) throw new CheckoutOwnershipError();
            const gates = await this.checkoutGates(input, current); current.assertCurrent();
            return this.serviceFor(seam).resumeCheckoutWindow(input, restored.resumption, restored.driver,
              { ...current, purchaseId: id, gates });
          } });
      });
    }
    return sweep;
  }

  admit(id: string, input: BeginCheckoutInput, source: DetachedCheckoutSource, requestCurrent: () => void,
    admitInput: (input: BeginCheckoutInput) => BeginCheckoutInput | void) {
    if (this.closed) throw new CheckoutOwnershipError();
    return this.operations.admit(id, input, source, requestCurrent, admitInput);
  }

  private async runAdmittedCheckout(input: BeginCheckoutInput, id: string, owner: DetachedCheckoutOwner) {
    owner.assertCurrent();
    const seam = this.deps.checkout.seam();
    if (!seam) throw new CheckoutOwnershipError();
    const gates = await this.checkoutGates(input, owner); owner.assertCurrent();
    return this.serviceFor(seam).beginCheckout(input, { ...owner, purchaseId: id, gates });
  }

  private async checkoutGates(input: BeginCheckoutInput, owner: DetachedCheckoutOwner): Promise<GateInput> {
    // Under 'prompt' the code is typed by the owner at payment time, so the
    // card is usable when everything else is stored and this host can ask.
    const securityCodePrompt = readCvvHandling(this.deps.config) === 'prompt' && this.deps.checkout.securityCodes !== undefined;
    const [usableCard, shippingAddress] = await mapLimit([
      () => hasUsableCard(this.deps.cards, input.cardId, owner, securityCodePrompt),
      () => hasShippingAddress(this.deps.checkout.addresses, owner),
    ], 2, read => read());
    owner.assertCurrent();
    if (typeof usableCard !== 'boolean' || typeof shippingAddress !== 'boolean') throw new CheckoutOwnershipError();
    const cardWithheldByCvvPrompt = !usableCard && !securityCodePrompt && readCvvHandling(this.deps.config) === 'prompt'
      && input.cardId.length > 0 && (await this.deps.cards.metadata(input.cardId)) !== null;
    owner.assertCurrent();
    return {
      enabled: readPaymentsEnabled(this.deps.config), isPaymentsLeader: this.deps.isPaymentsLeader(),
      hasUsableCard: usableCard, hasShippingAddress: shippingAddress, isOwnerDirectRequest: true,
      ...(securityCodePrompt ? { securityCodePrompt } : {}),
      ...(cardWithheldByCvvPrompt ? { cardWithheldByCvvPrompt } : {}),
    };
  }

  /**
   * The first payment store that has stopped itself, or null. The approvals
   * store counts only when approvals are required: with pre-approval off a
   * purchase does not need it.
   */
  hostStop(options: { readonly approvals: boolean }): PaymentStoreStop | null {
    const deps = this.deps, journal = this.journal as CheckoutJournal & { stopped?: () => PaymentStoreStop | null };
    const requests = deps.checkout.requests as (PaymentRequestStore & { stopped?: () => PaymentStoreStop | null }) | undefined;
    const stores: PaymentStoreHealth[] = [
      () => deps.budget.stopped(),
      () => journal.stopped?.() ?? null,
      () => requests?.stopped?.() ?? null,
      () => this.operations.stopped(),
      () => {
        try { deps.purchases.assertAvailable(); return null; }
        catch { return { store: 'purchase ledger', reason: 'it could not be read, a write to it could not be confirmed, or its file changed while the daemon was running' }; }
      },
      ...(options.approvals ? [() => deps.checkout.approvals.stopped()] : []),
    ];
    return paymentHostStop(stores);
  }

  /** The daemon types the card itself when its own purchase reaches payment.
   * A second fill through the verb could race that typing on the same fields. */
  daemonOwnsPage(sessionId: string, pageId: string): { readonly purchaseId: string; readonly phase: string } | null {
    const record = this.registry.current(sessionId, pageId);
    return record !== null && this.operations.isActive(record.purchaseId) ? { purchaseId: record.purchaseId, phase: record.phase } : null;
  }

  run<T>(callback: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new CheckoutOwnershipError());
    return this.work.run(callback);
  }

  ownership(options: CheckoutOperationOwnership) {
    const original = captureCheckoutOwnership(options);
    const signal = original.signal ? AbortSignal.any([original.signal, this.abort.signal]) : this.abort.signal;
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (this.closed) throw new CheckoutOwnershipError();
      original.assertCurrent();
      signal.throwIfAborted();
    };
    assertCurrent();
    return { signal, assertCurrent };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.closing = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    // Before any abort, so a purchase's release points can tell this host stop
    // from an owner cancel.
    this.operations.beginStop();
    this.closed = true;
    this.abort.abort(new CheckoutOwnershipError());
    const jobs: Promise<void>[] = [], errors: unknown[] = [];
    try { if (this.service) jobs.push(this.service.close()); } catch (error) { errors.push(error); }
    try { jobs.push(this.recovery.close()); } catch (error) { errors.push(error); }
    try { jobs.push(this.operations.close()); } catch (error) { errors.push(error); }
    try { jobs.push(this.reconciliations.close()); } catch (error) { errors.push(error); }
    jobs.push(this.work.join());
    void Promise.allSettled(jobs).then(results => {
      for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
      if (errors.length) reject(new AggregateError(errors, 'Checkout service did not close cleanly'));
      else resolve();
    });
    return this.closing;
  }
}

const CHECKOUT_UNAVAILABLE_MESSAGE =
  'Checkout is not available on this daemon right now: no browser is composed for it (no home directory '
  + 'configured, or the browser composition has not finished starting). Retry once the daemon has finished '
  + 'booting; if this persists, the daemon was started without a home directory to keep browser profiles in.';

/**
 * The action an owner approval authorizes: one `payments.checkout.begin`.
 * The approve verb mints against this constant and `begin` spends against it,
 * so the two can never drift into approving one verb and spending on another.
 */
export const CHECKOUT_APPROVAL_ACTION = 'payments.checkout.begin';

/**
 * The exact fields an approval binds, read the same way on both sides.
 *
 * The owner types the approval and the agent types the begin call, so the
 * fields are compared by meaning, not spelling: the merchant as its
 * registrable domain in lower case, the item with case and spacing folded,
 * and the amount as whole minor units of the budget currency ("25" and
 * "25.00" are the same approval). One parser for both verbs.
 */
export function checkoutApprovalContent(input: {
  readonly merchantDomain: string;
  readonly item: string;
  readonly amountMinorUnits: number | undefined;
}): Readonly<Record<string, string | undefined>> {
  return { merchant: approvalMerchant(input.merchantDomain), item: approvalItem(input.item),
    amount: input.amountMinorUnits === undefined ? undefined : String(input.amountMinorUnits) };
}
function approvalMerchant(value: string): string {
  let host = value.trim().toLowerCase();
  try { if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) host = new URL(host).hostname; } catch { /* Compared as typed. */ }
  return registrableDomain(host) ?? host;
}
function approvalItem(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}
/** An approval amount as the owner may type it: a plain amount, optionally with the budget currency's code or a currency sign. */
function approvalAmount(raw: string, currency: CurrencyCode): number | null {
  const plain = raw.trim().replace(new RegExp(`^${currency}\\s*|\\s*${currency}$`, 'i'), '').replace(/^[$€£¥]\s*/, '').trim();
  return parseRequestedMaximum(plain, currency);
}

/** How a begin call names the approve verb when it refuses, per mismatch. */
function approvalRefusalMessage(mismatch: string): string {
  if (mismatch === 'invalid-window') {
    return 'The purchase approval time window cannot be verified. Check the host clock, then obtain a new '
      + 'owner approval with payments.checkout.approve before beginning this purchase.';
  }
  if (mismatch === 'expired') {
    return 'The owner approval for this purchase has expired. Approvals last five minutes: call '
      + 'payments.checkout.approve again with the same merchantDomain, item and amount, then begin promptly.';
  }
  if (mismatch === 'different-content' || mismatch === 'no-content-binding') {
    return 'The owner approval on file was for a different purchase: its merchant, item or amount does not '
      + 'match this begin call (the amount is compared against requestedMax). payments.confirmEveryPurchase is on, '
      + 'so ask the owner to approve exactly this merchant, item and amount with /payments approve (payments.checkout.approve), then begin again.';
  }
  return 'payments.confirmEveryPurchase is on and this purchase has no owner approval on file. Ask the owner to '
    + 'approve it with /payments approve <merchant> <item> <amount> (payments.checkout.approve; the amount is this begin call\'s requestedMax), '
    + 'then begin within five minutes.';
}

/**
 * Spend the one approval matching this begin call. Null when none matches;
 * whether that refuses is the caller's (payments.confirmEveryPurchase).
 */
function takeCheckoutApproval(approvals: DaemonApprovalStore, content: Readonly<Record<string, string | undefined>>):
  { readonly taken: true } | { readonly taken: false; readonly mismatch: string } {
  let taken: ReturnType<DaemonApprovalStore['take']>;
  try {
    taken = approvals.take({ action: CHECKOUT_APPROVAL_ACTION, content });
  } catch (error) {
    // A failed confirmation may follow publication. Never claim the grant
    // is unspent or restore an in-memory copy over the actual file.
    void error;
    throw new HandlerError(
      'Spending the approval could not be confirmed. This request did not submit a purchase. Read payments.purchase.status, then restart the daemon if purchases stay paused.',
      'INTERNAL_ERROR',
      500,
    );
  }
  return taken.approval === null ? { taken: false, mismatch: taken.mismatch } : { taken: true };
}

/**
 * `payments.checkout.approve`.
 *
 * The owner approves one purchase in advance: merchant, item and the most it
 * may cost. The registration (register.ts) puts this handler behind the same
 * confirmation gate every destructive verb in this daemon uses (`confirm: true`
 * AND the explicit-user-request context flag), and the handler passes
 * `surface: 'owner-direct'` from its own code path, never from an argument.
 *
 * The amount is parsed here, in the budget currency, and an amount no begin
 * call could match is refused before anything is recorded. The minted record
 * is persisted (approval-store.ts), single-use, bound to the fields as
 * `checkoutApprovalContent` reads them, and expires in five minutes.
 * `payments.checkout.begin` spends it; see `checkoutBeginHandler`.
 */
export function checkoutApproveHandler(deps: PaymentsHandlerDeps): TypedHandler<unknown, Record<string, unknown>> {
  return async ({ body }) => {
    const params = asRecord(body);
    const merchantDomain = requireString(params['merchantDomain'], 'merchantDomain');
    const item = requireString(params['item'], 'item');
    const typed = requireString(params['amount'], 'amount');
    const currency = readPaymentsServiceConfig(deps.config).budgetCurrency;
    // Refused here, not at begin: an approval no begin could ever match is not recorded.
    const amountMinorUnits = approvalAmount(typed, currency);
    if (amountMinorUnits === null) throw invalid('amount', `must be one amount in ${currency} such as ${plainAmountExample(currency)}; nothing was approved.`);
    const exponent = minorUnitExponent(currency);
    const amount = exponent === 0 ? String(amountMinorUnits)
      : `${String(Math.floor(amountMinorUnits / 10 ** exponent))}.${String(amountMinorUnits % 10 ** exponent).padStart(exponent, '0')}`;
    let approval;
    try {
      approval = deps.checkout.approvals.grant({
        action: CHECKOUT_APPROVAL_ACTION,
        content: checkoutApprovalContent({ merchantDomain, item, amountMinorUnits }),
      });
    } catch (error) {
      // A full store is a plain refusal that names its cap; nothing was recorded.
      if (error instanceof PaymentApprovalStoreError && error.kind === 'full') throw new HandlerError(error.message, 'FAILED_PRECONDITION', 409);
      // A write error may follow rename. Report uncertainty without claiming
      // that no approval exists or echoing raw filesystem diagnostics.
      void error;
      throw new HandlerError('Recording the approval could not be confirmed. Inspect the original purchase and approval evidence before trying again.', 'INTERNAL_ERROR', 500);
    }
    // Named fields, never a spread, the same containment rule as every other
    // response in this family.
    return {
      approved: true,
      action: CHECKOUT_APPROVAL_ACTION,
      merchantDomain,
      item,
      amount,
      expiresAt: approval.expiresAt,
    };
  };
}

/**
 * `payments.checkout.begin`.
 *
 * Admission requires explicit-user-request metadata AND the transport's
 * current paired administrative principal with write:payments. A body flag
 * does not mint that authority. The original request remains current until
 * its stable requestId is durably published. The daemon then owns execution,
 * retaining original paired authorization, host settings and browser source,
 * independently of the socket. Accepted never means successfully purchased.
 *
 * Inside the owner's limits the agent buys on the owner's behalf: no prior
 * approval is needed unless `payments.confirmEveryPurchase` is on. An approval
 * the owner gave in advance (`payments.checkout.approve`) matching this
 * merchant, item and `requestedMax` is spent at admission, after the
 * read-only steps and immediately before the durable admission write, and a
 * final total within it needs no window. With `payments.confirmEveryPurchase`
 * on, a begin with no matching approval is refused naming `/payments approve`.
 *
 * Before any of that, one health read: a payment store that stopped itself
 * refuses the purchase with the sentence that names it, approval unspent.
 *
 * The money controls downstream are unchanged: the budget ledger (RESERVE,
 * step 5), the purchase notices and their approval/veto windows (NOTICE +
 * WINDOW, step 6), and the card-material guard (`cardFieldGuard`, armed only
 * immediately before typing, never before). See `checkout-flow.ts`'s header.
 */
export function checkoutBeginHandler(deps: PaymentsHandlerDeps, holder: CheckoutServiceHolder): TypedHandler<unknown, Record<string, unknown>> {
  return async ({ body, context }) => holder.run(async () => {
    // Set the moment the owner's approval has been spent, so a failure after it
    // can say so instead of leaving the caller to find out on the next begin.
    let approvalSpent = false;
    const spentNote = (message: string): string => (approvalSpent
      ? `${message} The owner's approval for this purchase was spent: ask the owner to approve it again (payments.checkout.approve) and begin with a new requestId.`
      : message);
    try {
      const config = readPaymentsServiceConfig(deps.config), confirmEvery = readConfirmEveryPurchase(deps.config);
      const params = asRecord(body), id = checkoutRequestId(params['requestId']);
      const input = parseBeginCheckoutInput(params, { budgetCurrency: config.budgetCurrency, defaultCardId: readDefaultCardId(deps.config) });
      if (confirmEvery && input.requestedMax === undefined) {
        throw invalid('requestedMax', 'is required while payments.confirmEveryPurchase is on: it is the amount the owner approved.');
      }
      const seam = deps.checkout.seam();
      if (!seam) throw new HandlerError(CHECKOUT_UNAVAILABLE_MESSAGE, 'FAILED_PRECONDITION', 409);
      const source = retainDetachedCheckout(deps, seam, context);
      const admission = retainCheckoutInvocation(deps, seam, context);
      // One health read, before any approval is spent: a stopped store names
      // itself here instead of failing later with its own sentence.
      const stop = holder.hostStop({ approvals: confirmEvery });
      if (stop) throw new PaymentHostStoppedError(stop);
      const amountMinorUnits = input.requestedMax === undefined ? undefined : parseRequestedMaximum(input.requestedMax, config.budgetCurrency) ?? undefined;
      const content = checkoutApprovalContent({ merchantDomain: input.merchantDomain, item: input.item, amountMinorUnits });
      const operation = await holder.admit(id, input, source, admission.assertCurrent, admitted => {
        // An approval binds an amount, so a begin without one cannot match any.
        if (amountMinorUnits === undefined) return admitted;
        let taken: ReturnType<typeof takeCheckoutApproval>;
        try { taken = takeCheckoutApproval(deps.checkout.approvals, content); }
        catch (error) { if (confirmEvery) throw error; return admitted; }
        if (!taken.taken) {
          if (confirmEvery) throw new HandlerError(approvalRefusalMessage(taken.mismatch), 'OWNER_APPROVAL_REQUIRED', 403);
          return admitted;
        }
        approvalSpent = true;
        return { ...admitted, ownerApprovedMaxMinorUnits: amountMinorUnits };
      });
      return { outcome: 'accepted', purchaseId: operation.purchaseId, reason: null, merchantOrderId: null,
        totalMinorUnits: null, currency: null, shippingTierUsed: null, steppedDown: false, challengeStep: null };
    } catch (error) {
      if (error instanceof HandlerError) throw error;
      if (error instanceof PaymentHostStoppedError) throw new HandlerError(error.message, 'FAILED_PRECONDITION', 409);
      if (error instanceof PaymentOperationStoreError && error.kind === 'invalid') throw new HandlerError(error.message, 'INVALID_ARGUMENT', 400);
      if (error instanceof PaymentOperationStoreError || error instanceof PaymentPurchaseLedgerError || error instanceof PaymentCheckoutJournalUnavailableError || error instanceof ProtectedPaymentRequestError || error instanceof BrowserPageConnectionError) {
        throw new HandlerError(spentNote(error.message), error instanceof PaymentOperationStoreError && error.kind === 'exists' ? 'ALREADY_EXISTS' : 'FAILED_PRECONDITION', 409);
      }
      throw new HandlerError(spentNote('This checkout could not be admitted. Read the original purchase status before trying again.'), 'INTERNAL_ERROR', 500);
    }
  });
}

/** Fill is restricted by the original invocation and registration lifetime.
 * It uses the registry shared with begin; it does not grant submit authority. */
export function checkoutFillCardHandler(deps: PaymentsHandlerDeps, holder: CheckoutServiceHolder): TypedHandler<unknown, Record<string, unknown>> {
  return async ({ body, context }) => holder.run(async () => {
    const params = asRecord(body);
    const input = parseFillCardInput(params);

    const seam = deps.checkout.seam();
    if (seam === undefined) {
      throw new HandlerError(CHECKOUT_UNAVAILABLE_MESSAGE, 'FAILED_PRECONDITION', 409);
    }

    const refuseDaemonOwned = (owned: { readonly purchaseId: string; readonly phase: string }): HandlerError => new HandlerError(
      `Refused: purchase ${owned.purchaseId} on this page is at the "${owned.phase}" stage and is being run by the daemon, which types `
      + 'the card itself when the purchase reaches payment. Do not fill it from here; read payments.purchase.status for its progress.', 'INVALID_ARGUMENT', 400);
    const owned = holder.daemonOwnsPage(input.sessionId, input.pageId);
    if (owned !== null) throw refuseDaemonOwned(owned);
    const invocation = holder.ownership(retainCheckoutInvocation(deps, seam, context));
    // Held through every await of the fill, not only checked once before it.
    const owner = { signal: invocation.signal, assertCurrent: () => {
      invocation.assertCurrent();
      const current = holder.daemonOwnsPage(input.sessionId, input.pageId);
      if (current !== null) throw refuseDaemonOwned(current);
    } };
    const service = holder.serviceFor(seam);

    try {
      const result = await service.fillCardIntoCheckout(input, owner);
      return fillCardResultView(result);
    } catch (error) {
      // A `FillCardRefusal` is the owner's business and carries no material
      // (fill-card.ts's own contract), so it is forwarded; anything else is
      // discarded, the failing call had the card in its stack, and an error
      // string is a read path like any other.
      if (error instanceof Error && error.name === 'FillCardRefusal') {
        throw new HandlerError(error.message, 'INVALID_ARGUMENT', 400);
      }
      void error;
      throw new HandlerError('Filling the card into this checkout failed. Nothing was submitted.', 'INTERNAL_ERROR', 500);
    }
  });
}
