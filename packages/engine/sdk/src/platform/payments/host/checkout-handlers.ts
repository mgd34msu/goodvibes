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
/**
 * checkout-handlers.ts, `payments.checkout.begin` / `payments.checkout.fillCard`.
 *
 * Split out of register.ts for the 800-line file cap, the same reason
 * daemon-handler-composition.ts/ci-watch-composition.ts exist as their own
 * modules; no behavioural change from being here rather than there.
 *
 * ── Why these two verbs are local wrappers, not the SDK's own route ───────
 *
 * `registerPaymentsGatewayMethods`'s own `createPaymentsCheckoutBeginHandler`/
 * `createPaymentsCheckoutFillCardHandler` call
 * `service.beginCheckout(input)`/`service.fillCardIntoCheckout(input)` with no
 * invocation context at all. This daemon's whole "approving a purchase is a
 * distinct act" ruling (see `checkoutBeginHandler` below) needs
 * `context.explicitUserRequest`, which only reaches a handler attached through
 * this daemon's own `registerCatalogHandlers` (register.ts). So both verbs are
 * attached there as local wrappers, reading and shaping the SAME wire shapes
 * `routes/payments.ts` does (ported here rather than imported, since the SDK
 * does not publish those parsing functions on their own), and calling into the
 * ONE `PaymentsGatewayServiceImpl` a registration's checkout pair shares for
 * its whole life (see `CheckoutServiceHolder` below for why one, not one per
 * call).
 */
import { checkAddress } from '../address.js';
import type { AddressStore } from '../address.js';
import { CheckoutRegistry } from '../checkout-registry.js';
import { CheckoutRecovery } from '../checkout-recovery.js';
import type { CheckoutJournal } from '../checkout-registry.js';
import type { MerchantJudgePort } from '../merchant-recourse.js';
import type { PaymentNotifier } from '../payment-ports.js';
import type { PaymentReplyInbox } from '../reply-inbox.js';
import { PaymentsGatewayServiceImpl } from '../payments-gateway-service.js';
import { readPaymentsEnabled, readPaymentsServiceConfig } from '../payments-config.js';
import { SHIPPING_TIERS } from '../types.js';
import type { ShippingTier } from '../types.js';
import type { UntrustedContentLedger } from '../../security/untrusted-content.js';
import type { BrowserCheckoutSeam } from '../../control-plane/routes/browser-composition.js';
import { HandlerError } from './handler-plumbing.js';
import type { TypedHandler } from './handler-plumbing.js';
import type { DaemonApprovalStore } from './approval-store.js';
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
   * A GETTER, not a value: this composition is built and register.ts's
   * handlers are registered before the browser composition runs (see
   * runtime/browser-checkout-seam-holder.ts), so the seam is not there yet at
   * REGISTRATION time and must be read fresh at CALL time. `undefined` means
   * either "this daemon never builds a browser" (no home directory) or "not
   * wired yet"; by the time any real invocation reaches this handler the
   * daemon has finished booting and it is the former or nothing, and the
   * handler refuses honestly either way.
   */
  readonly seam: () => BrowserCheckoutSeam | undefined;
  readonly addresses: AddressStore;
  readonly notifier: PaymentNotifier;
  /** The exact daemon-owned inbox also borrowed by channel reply ingress. */
  readonly replies?: PaymentReplyInbox | undefined;
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
   * restart; tests may compose the SDK's `MemoryCheckoutJournal`.
   */
  readonly journal: CheckoutJournal;
  readonly operations: DurablePaymentOperations;
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

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Deliberately STRICTER than the sdk's own route (routes/payments.ts), which
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

/** The exact shape `PaymentsGatewayServiceImpl.beginCheckout` wants, read off the wire. */
function parseBeginCheckoutInput(params: Record<string, unknown>): Parameters<PaymentsGatewayServiceImpl['beginCheckout']>[0] {
  const requestedLines = readObjectRows(params['requestedLines'], 'requestedLines', true).map((entry, index) => ({
    label: requireString(entry['label'], `requestedLines[${String(index)}].label`),
    quantity: requireWholeNumber(entry['quantity'], `requestedLines[${String(index)}].quantity`),
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
  return {
    sessionId: requireString(params['sessionId'], 'sessionId'),
    pageId: requireString(params['pageId'], 'pageId'),
    merchantDomain: requireString(params['merchantDomain'], 'merchantDomain'),
    checkoutUrl: requireString(params['checkoutUrl'], 'checkoutUrl'),
    item: requireString(params['item'], 'item'),
    cardId: requireString(params['cardId'], 'cardId'),
    requestedLines,
    reading: {
      lines,
      tax: optionalNonEmptyString(params['tax']) ?? null,
      fees,
      shippingOptions,
      statedTotal: optionalNonEmptyString(params['statedTotal']) ?? null,
      currency: optionalNonEmptyString(params['currency']) ?? null,
      orderSummaryText: typeof params['orderSummaryText'] === 'string' ? params['orderSummaryText'] : '',
    },
    controls: {
      cardFields,
      addressFields,
      shippingTargets: readStringRows(params['shippingTargets'], 'shippingTargets'),
      placeOrderTarget: requireString(params['placeOrderTarget'], 'placeOrderTarget'),
      expirySeparator: optionalNonEmptyString(params['expirySeparator']),
      twoDigitYear: typeof twoDigit === 'boolean' ? twoDigit : undefined,
    },
    preferredTier: optionalShippingTier(params['preferredTier']),
    requestedMax: params['requestedMax'] === undefined ? undefined : requireString(params['requestedMax'], 'requestedMax'),
    // The sdk's own route (routes/payments.ts) never reads this field off the
    // wire at all: `PaymentBeginCheckoutInput` has no `merchantDiscovered`
    // property, and `service.beginCheckout` is called with it simply absent,
    // which `checkout-flow.ts` then defaults to false. This daemon matches
    // that byte for byte rather than trusting a caller-supplied flag:
    // `merchantDiscovered` skips the taint check on the merchant and the
    // checkout url (taint-gate.ts), and nothing on this wire path can attest
    // that a page was actually browsed to rather than simply named by
    // whoever is calling. A future attested-discovery flow may reintroduce
    // this deliberately, with its own provenance, not as a bare wire field.
    merchantDiscovered: false,
  };
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
  // sdk's own fillCard route (routes/payments.ts) keeps an EMPTY separator
  // distinct from an ABSENT one (a caller that says "" is asking for the
  // digits run together, `0729`, and one that says nothing gets the default
  // `/`), and `optionalNonEmptyString` would collapse both to `undefined`.
  // `parseBeginCheckoutInput`'s own `expirySeparator` field stays on
  // `optionalNonEmptyString`, matching the sdk's begin route instead, which
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
 * Allowlisted, the same reason `sanitizeFillResult` exists in the SDK's own
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
async function hasUsableCard(cards: DaemonCardStore, cardId: string, owner: CheckoutOperationOwnership): Promise<boolean> {
  owner.assertCurrent?.();
  if (cardId.length === 0) return false;
  const metadata = await cards.metadata(cardId);
  owner.assertCurrent?.();
  if (metadata === null) return false;
  const complete = await cards.materialComplete(cardId);
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
  private readonly work = new OwnedWork();
  private readonly abort = new AbortController();
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly deps: PaymentsHandlerDeps,
    private readonly journal: CheckoutJournal,
  ) {
    this.operations = new CheckoutOperations(deps.checkout.operations, journal, deps.purchases,
      (input, id, owner) => this.runAdmittedCheckout(input, id, owner), deps.now);
    this.registry = new CheckoutRegistry({ list: () => journal.list(), remove: id => journal.remove(id),
      put: async record => { await journal.put(record); this.operations.progress(record); } });
    this.recovery = new CheckoutRecovery({ registry: this.registry, journal,
      ledger: deps.budget, purchases: deps.purchases, notifier: deps.checkout.notifier,
      retainInterrupted: id => deps.checkout.operations.retainRecovery(id),
      isPaymentsLeader: deps.isPaymentsLeader, now: deps.now });
  }

  serviceFor(seam: BrowserCheckoutSeam): PaymentsGatewayServiceImpl {
    if (this.closed) throw new HandlerError('Checkout service is closed.', 'FAILED_PRECONDITION', 409);
    this.service ??= buildCheckoutService(this.deps, seam, this.journal, this.registry);
    return this.service;
  }

  async recoverInterruptedCheckouts() {
    const sweep = await this.recovery.recoverInterruptedCheckouts();
    if (sweep.swept) await this.operations.recover();
    return sweep;
  }

  admit(id: string, input: BeginCheckoutInput, source: DetachedCheckoutSource, requestCurrent: () => void, consume: () => void) {
    if (this.closed) throw new CheckoutOwnershipError();
    return this.operations.admit(id, input, source, requestCurrent, consume);
  }

  private async runAdmittedCheckout(input: BeginCheckoutInput, id: string, owner: DetachedCheckoutOwner) {
    owner.assertCurrent();
    const seam = this.deps.checkout.seam();
    if (!seam) throw new CheckoutOwnershipError();
    const [usableCard, shippingAddress] = await mapLimit([
      () => hasUsableCard(this.deps.cards, input.cardId, owner),
      () => hasShippingAddress(this.deps.checkout.addresses, owner),
    ], 2, read => read());
    owner.assertCurrent();
    return this.serviceFor(seam).beginCheckout(input, { ...owner, purchaseId: id, gates: {
      enabled: readPaymentsEnabled(this.deps.config), isPaymentsLeader: this.deps.isPaymentsLeader(),
      hasUsableCard: usableCard, hasShippingAddress: shippingAddress, isOwnerDirectRequest: true,
    } });
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
    this.closed = true;
    this.abort.abort(new CheckoutOwnershipError());
    const jobs: Promise<void>[] = [], errors: unknown[] = [];
    try { if (this.service) jobs.push(this.service.close()); } catch (error) { errors.push(error); }
    try { jobs.push(this.recovery.close()); } catch (error) { errors.push(error); }
    try { jobs.push(this.operations.close()); } catch (error) { errors.push(error); }
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
 * The exact fields an approval binds, built the same way on both sides.
 *
 * On the approve side the values are what the owner typed; on the begin side
 * they are read from the begin call itself (`merchantDomain`, `item`,
 * `requestedMax`). One builder for both is what makes the fingerprint a
 * comparison of the deed rather than two modules' ideas of it.
 */
export function checkoutApprovalContent(input: {
  readonly merchantDomain: string;
  readonly item: string;
  readonly amount: string | undefined;
}): Readonly<Record<string, string | undefined>> {
  return { merchant: input.merchantDomain, item: input.item, amount: input.amount };
}

/** How a begin call names the approve verb when it refuses, per mismatch. */
function approvalRefusalMessage(mismatch: string): string {
  if (mismatch === 'expired') {
    return 'The owner approval for this purchase has expired. Approvals last five minutes: call '
      + 'payments.checkout.approve again with the same merchantDomain, item and amount, then begin promptly.';
  }
  if (mismatch === 'different-content' || mismatch === 'no-content-binding') {
    return 'The owner approval on file was for a different purchase: its merchant, item or amount does not '
      + 'match this begin call (the amount is compared against requestedMax). Call payments.checkout.approve '
      + 'with exactly what this begin call names, then begin again.';
  }
  return 'This purchase has no owner approval on file. A human approves it first, out of band from this '
    + 'call: invoke payments.checkout.approve with this purchase\'s merchantDomain, item and amount (the '
    + 'begin call\'s requestedMax), then begin within five minutes.';
}

/**
 * Spend the one approval matching this begin call, or refuse naming the
 * approve verb. Consuming before the service runs is the sdk store's own
 * safe direction: an approval taken for a begin that then refuses on a later
 * gate is spent, never silently reusable.
 */
function consumeCheckoutApproval(
  approvals: DaemonApprovalStore,
  input: { readonly merchantDomain: string; readonly item: string; readonly requestedMax?: string | undefined },
): void {
  let taken: ReturnType<DaemonApprovalStore['take']>;
  try {
    taken = approvals.take({
      action: CHECKOUT_APPROVAL_ACTION,
      content: checkoutApprovalContent({
        merchantDomain: input.merchantDomain,
        item: input.item,
        amount: input.requestedMax,
      }),
    });
  } catch (error) {
    // A failed confirmation may follow publication. Never claim the grant
    // is unspent or restore an in-memory copy over the actual file.
    void error;
    throw new HandlerError(
      'Spending the approval could not be confirmed. This request did not submit a purchase. Inspect its original status and approval evidence before trying again.',
      'INTERNAL_ERROR',
      500,
    );
  }
  if (taken.approval === null) {
    throw new HandlerError(approvalRefusalMessage(taken.mismatch), 'OWNER_APPROVAL_REQUIRED', 403);
  }
}

/**
 * `payments.checkout.approve`.
 *
 * The distinct act the sdk's owner-approval ruling requires: a HUMAN, on a
 * surface with command authority, names one purchase and approves it. The
 * registration (register.ts) puts this handler behind the same confirmation
 * gate every destructive verb in this daemon uses (`confirm: true` in the
 * body AND the explicit-user-request context flag), and the handler passes
 * `surface: 'owner-direct'` from its own code path, never from an argument,
 * which is the property `grantOwnerApproval` exists to enforce.
 *
 * The minted record is persisted (approval-store.ts), single-use, bound to
 * the exact merchant + item + amount fields named here, and expires in five
 * minutes. `payments.checkout.begin` spends it; see `checkoutBeginHandler`.
 */
export function checkoutApproveHandler(deps: PaymentsHandlerDeps): TypedHandler<unknown, Record<string, unknown>> {
  return async ({ body }) => {
    const params = asRecord(body);
    const merchantDomain = requireString(params['merchantDomain'], 'merchantDomain');
    const item = requireString(params['item'], 'item');
    const amount = requireString(params['amount'], 'amount');
    let approval;
    try {
      approval = deps.checkout.approvals.grant({
        action: CHECKOUT_APPROVAL_ACTION,
        content: checkoutApprovalContent({ merchantDomain, item, amount }),
      });
    } catch (error) {
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
 * ── What actually gates a purchase here ────────────────────────────────────
 *
 * Admission requires explicit-user-request metadata AND the transport's
 * current paired administrative principal with write:payments. A body flag
 * does not mint that authority. The original request remains current until
 * its stable requestId is durably published. The daemon then owns execution,
 * retaining original paired authorization, host settings and browser source,
 * independently of the socket. Accepted never means successfully purchased.
 *
 * ── The genuine owner-approval record, consumed here ───────────────────────
 *
 * Behind that outer gate sits the distinct-act approval the sdk's
 * owner-approval ruling describes (platform/security/owner-approval.ts): a
 * persisted record that a human called `payments.checkout.approve`, out of
 * band from whatever conversation produced this begin call, naming ONE
 * purchase by merchant, item and amount. This handler spends exactly one
 * matching record per begin (`DaemonApprovalStore.take`, approval-store.ts:
 * single-use, content-bound via the sdk's own fingerprint, five-minute TTL)
 * and refuses, naming the approve verb, when none matches. The record is
 * consumed BEFORE the service runs, which is the sdk store's own safe
 * direction: a taken approval whose begin then refuses on a later gate is
 * spent, never quietly retried.
 *
 * The binding fields are `merchantDomain`, `item` and `requestedMax`, read
 * from THIS begin call and fingerprinted the same way the approve verb
 * fingerprinted what the owner typed, so a begin whose merchant, item or
 * amount differs from what was approved is `different-content`, not a match.
 * An earlier mechanism that armed `seam.armSubmitApproval` with a
 * content-free approval was deleted rather than shipped, because an approval
 * with no content binding clears nothing real; this record is the strong
 * form, minted with the exact fields.
 *
 * The money controls downstream of both gates are unchanged: the budget
 * ledger (RESERVE, step 5), the purchase notices and their approval/veto
 * decision windows (NOTICE + WINDOW, step 6), and the card-material guard
 * (`cardFieldGuard`, armed only immediately before typing, never before).
 * See `checkout-flow.ts`'s own header for the full order.
 */
export function checkoutBeginHandler(deps: PaymentsHandlerDeps, holder: CheckoutServiceHolder): TypedHandler<unknown, Record<string, unknown>> {
  return async ({ body, context }) => holder.run(async () => {
    try {
      const params = asRecord(body), id = checkoutRequestId(params['requestId']), input = parseBeginCheckoutInput(params);
      const seam = deps.checkout.seam();
      if (!seam) throw new HandlerError(CHECKOUT_UNAVAILABLE_MESSAGE, 'FAILED_PRECONDITION', 409);
      const source = retainDetachedCheckout(deps, seam, context);
      const admission = retainCheckoutInvocation(deps, seam, context);
      deps.purchases.assertAvailable();
      const operation = holder.admit(id, input, source, admission.assertCurrent, () => consumeCheckoutApproval(deps.checkout.approvals, input));
      return { outcome: 'accepted', purchaseId: operation.purchaseId, reason: null, merchantOrderId: null,
        totalMinorUnits: null, currency: null, shippingTierUsed: null, steppedDown: false, challengeStep: null };
    } catch (error) {
      if (error instanceof HandlerError) throw error;
      if (error instanceof PaymentOperationStoreError && error.kind === 'invalid') throw new HandlerError(error.message, 'INVALID_ARGUMENT', 400);
      if (error instanceof PaymentOperationStoreError || error instanceof PaymentPurchaseLedgerError || error instanceof PaymentCheckoutJournalUnavailableError) {
        throw new HandlerError(error.message, error instanceof PaymentOperationStoreError && error.kind === 'exists' ? 'ALREADY_EXISTS' : 'FAILED_PRECONDITION', 409);
      }
      throw new HandlerError('This checkout could not be admitted. Read the original purchase status before trying again.', 'INTERNAL_ERROR', 500);
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

    const owner = holder.ownership(retainCheckoutInvocation(deps, seam, context));
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
