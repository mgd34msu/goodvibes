/**
 * routes/payments.ts, the platform handlers for `payments.*`.
 *
 * The daemon is the process that holds the card and charges it, with every
 * surface closed and across restarts. In the daemon, `payments/host/register.ts`
 * replaces `cards.create`, `purchases.list` and `checkout.begin` with its own
 * handlers (which add ownership, approval and admission), so for those three
 * the code here serves only a host that composes the platform groups without
 * the daemon's payments host. A validation change
 * to one of them belongs in both places. This module is deliberately thin: it maps
 * the descriptors' declared shapes onto a narrow service slice, performs no
 * I/O, holds no credential, and never touches a card number.
 *
 * Two properties are enforced HERE rather than merely advertised, so neither
 * rests on schema validation being reached by every transport:
 *
 *  - **Card material is write-only.** `cards.create` takes the number, expiry,
 *    CVV and cardholder name and returns the METADATA record. Nothing in this
 *    module can return a stored secret, and `sanitizeCardMetadata` strips any
 *    field a future service might mistakenly hand back, a service bug becomes
 *    a missing field rather than a leaked card.
 *  - **Card material never reaches an error.** Failures report the stage and a
 *    plain reason; what was submitted is never part of a diagnostic, because
 *    an error string is a read path like any other.
 *
 * The daemon types the card itself, inside the purchase it runs
 * (`payments.checkout.begin`); no verb here types a card or returns one.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import type { CardMetadata } from '../../payments/types.js';
import type { PoolSnapshot } from '../../payments/budget.js';

/** What a purchase looks like once the audit ledger has recorded it. */
export interface PaymentPurchaseView {
  readonly purchaseId: string;
  readonly atUtc: string;
  readonly dayKey: string;
  readonly timezone: string;
  readonly merchantDomain: string;
  readonly item: string;
  readonly currency: string;
  readonly itemMinorUnits: number;
  readonly taxMinorUnits: number;
  readonly feesMinorUnits: number;
  readonly shippingMinorUnits: number;
  readonly totalMinorUnits: number;
  /** Original request-specific limit; absent when the owner supplied none. */
  readonly requestedMaximumMinorUnits?: number | undefined;
  readonly shippingTierRequested: string;
  readonly shippingTierUsed: string;
  readonly steppedDown: boolean;
  readonly itemPoolDraw: number;
  readonly overagePoolDraw: number;
  readonly tolerancePoolDraw: number;
  readonly cardLast4: string;
  readonly windowKind: string;
  readonly windowOutcome: string;
  readonly answeredBy: string | null;
  readonly outcome: string;
  readonly refusalReason: string | null;
  readonly merchantOrderId: string | null;
  readonly refundedAt: string | null;
  /** Whether the merchant carried established recourse, and on what grounds. */
  readonly merchantRecognised: boolean;
  readonly merchantQualifier: string | null;
  /** Whether the owner named the storefront or it was found while browsing. */
  readonly merchantDiscovered: boolean;
}

export interface PaymentsBudgetView {
  readonly enabled: boolean;
  readonly currency: string;
  readonly pools: PoolSnapshot;
  readonly reservationCount: number;
  readonly isPaymentsLeader: boolean;
}

/** Card metadata plus whether the secret store holds every required field. */
export interface PaymentCardView extends CardMetadata {
  readonly materialComplete: boolean;
}

/** The narrow slice of the capability these handlers need. */
export interface PaymentsGatewayService {
  /**
   * Settle checkouts a restart interrupted, per the journal's phase verdicts
   * and the windows' documented silence rules, returning the sweep envelope
   * (`CheckoutRecoverySweep`: swept or skipped, plus settlements). Optional
   * so a narrower test double stays valid; when present, registration runs
   * it to completion at attach time, before any checkout verb can be served.
   */
  recoverInterruptedCheckouts?(): Promise<unknown>;
  budgetStatus(): Promise<PaymentsBudgetView>;
  listCards(): Promise<{ cards: readonly PaymentCardView[]; defaultCardId: string }>;
  /**
   * Store a card. Implementations write the material to the daemon secret
   * store and MUST NOT return any of it.
   */
  createCard(input: {
    readonly label: string;
    readonly kind: 'virtual' | 'real';
    readonly number: string;
    readonly expiryMonth: number;
    readonly expiryYear: number;
    readonly cvv: string;
    readonly cardholderName: string;
    readonly issuerCapMinorUnits: number | null;
  }): Promise<PaymentCardView>;
  deleteCard(id: string): Promise<{ deleted: boolean; secretsCleared: number }>;
  /**
   * Run a purchase against an open browser page.
   *
   * The implementation owns the whole decision order; this module only shapes
   * the call. Amounts arrive as STRINGS and are parsed by the daemon, so no
   * number on this path was parsed by a caller.
   */
  beginCheckout(input: PaymentBeginCheckoutInput): Promise<PaymentBeginResultView>;
  listPurchases(input: { readonly limit: number; readonly dayKey: string | undefined }):
    Promise<{ purchases: readonly PaymentPurchaseView[]; total: number; reconciliations?: readonly {
      readonly purchaseId: string; readonly operationId: string; readonly outcome: 'purchased' | 'not-purchased';
      readonly principalId: string; readonly atMs: number; readonly merchantDomain: string; readonly totalMinorUnits: number; readonly currency: string;
    }[] }>;
}

/** The shape `payments.checkout.begin` hands the service, already validated. */
export interface PaymentBeginCheckoutInput {
  readonly requestId: string;
  readonly sessionId: string;
  readonly pageId: string;
  readonly merchantDomain: string;
  readonly checkoutUrl: string;
  readonly item: string;
  readonly cardId: string;
  readonly requestedLines: readonly { readonly label: string; readonly quantity: number }[];
  readonly reading: {
    readonly lines: readonly { readonly label: string; readonly quantity: string; readonly unitPrice: string }[];
    readonly tax: string | null;
    readonly fees: readonly { readonly label: string; readonly amount: string }[];
    readonly shippingOptions: readonly { readonly label: string; readonly cost: string }[];
    readonly statedTotal: string | null;
    readonly currency: string | null;
    readonly orderSummaryText: string;
  };
  readonly controls: {
    readonly cardFields: readonly { readonly field: string; readonly ref: string }[];
    readonly addressFields: readonly { readonly kind: string; readonly field: string; readonly ref: string }[];
    readonly shippingTargets: readonly string[];
    readonly placeOrderTarget: string;
    readonly expirySeparator: string | undefined;
    readonly twoDigitYear: boolean | undefined;
  };
  readonly preferredTier: string | undefined;
  readonly requestedMax: string | undefined;
}

/** What a begin reports. Amounts are integers the daemon computed. */
export interface PaymentBeginResultView {
  readonly outcome: string;
  readonly purchaseId: string | null;
  readonly reason: string | null;
  readonly merchantOrderId: string | null;
  readonly totalMinorUnits: number | null;
  readonly currency: string | null;
  readonly shippingTierUsed: string | null;
  readonly steppedDown: boolean;
  readonly challengeStep: string | null;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GatewayVerbError(`${field} is required.`, 'INVALID_ARGUMENT', 400, field);
  }
  return value.trim();
}

function readInteger(value: unknown, field: string, min?: number, max?: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || (min !== undefined && value < min) || (max !== undefined && value > max)) {
    const range = min !== undefined && max !== undefined ? ` between ${String(min)} and ${String(max)}` : '';
    throw new GatewayVerbError(`${field} must be a whole number${range}.`, 'INVALID_ARGUMENT', 400, field);
  }
  return value;
}

/** Absent or null means "no cap"; anything else must be a non-negative whole number, never silently dropped. */
function readIssuerCap(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new GatewayVerbError('issuerCapMinorUnits must be a non-negative whole number of minor units, or omitted for no cap.', 'INVALID_ARGUMENT', 400, 'issuerCapMinorUnits');
  }
  return value;
}

/**
 * A GET's `limit` arrives as a query string ("100", not 100). A numeric string
 * parses the same as the number it names; anything else, including a
 * non-digit string, is treated as absent and the caller falls back to the
 * default, exactly as a wrong-typed value does today.
 */
function readOptionalPositiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * The exact set of card fields that may leave this process.
 *
 * Built by naming what is ALLOWED rather than by deleting what is forbidden.
 * A denylist silently ships whatever field a later change adds; an allowlist
 * silently drops it, and for card material that is the correct direction to
 * fail.
 */
function sanitizeCardMetadata(card: PaymentCardView): PaymentCardView {
  return {
    id: card.id,
    label: card.label,
    brand: card.brand,
    last4: card.last4,
    kind: card.kind,
    expiryMonth: card.expiryMonth,
    expiryYear: card.expiryYear,
    issuerCapMinorUnits: card.issuerCapMinorUnits,
    addedAt: card.addedAt,
    materialComplete: card.materialComplete,
  };
}

export function createPaymentsBudgetStatusHandler(service: PaymentsGatewayService): GatewayMethodHandler {
  return async () => {
    const view = await service.budgetStatus();
    return {
      enabled: view.enabled,
      dayKey: view.pools.dayKey,
      timezone: view.pools.timezone,
      currency: view.currency,
      item: view.pools.item,
      overage: view.pools.overage,
      tolerance: view.pools.tolerance,
      reservationCount: view.reservationCount,
      isPaymentsLeader: view.isPaymentsLeader,
    };
  };
}

export function createPaymentsCardsListHandler(service: PaymentsGatewayService): GatewayMethodHandler {
  return async () => {
    const { cards, defaultCardId } = await service.listCards();
    return { cards: cards.map(sanitizeCardMetadata), defaultCardId };
  };
}

export function createPaymentsCardsCreateHandler(service: PaymentsGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const kind = readString(params['kind'], 'kind');
    if (kind !== 'virtual' && kind !== 'real') {
      throw new GatewayVerbError("kind must be 'virtual' or 'real'.", 'INVALID_ARGUMENT', 400);
    }
    // Field reading happens BEFORE the storage try/catch below, on purpose: a
    // validation failure here must surface as the field-named 400 these
    // readers throw, not get swallowed into the storage handler's blanket 500.
    const issuerCap = params['issuerCapMinorUnits'];
    const label = readString(params['label'], 'label');
    const number = readString(params['number'], 'number');
    const expiryMonth = readInteger(params['expiryMonth'], 'expiryMonth', 1, 12);
    const expiryYear = readInteger(params['expiryYear'], 'expiryYear', 1000, 9999);
    const cvv = readString(params['cvv'], 'cvv');
    const cardholderName = readString(params['cardholderName'], 'cardholderName');
    const issuerCapMinorUnits = readIssuerCap(issuerCap);

    let card: PaymentCardView;
    try {
      card = await service.createCard({
        label,
        kind,
        number,
        expiryMonth,
        expiryYear,
        cvv,
        cardholderName,
        issuerCapMinorUnits,
      });
    } catch (error) {
      // Deliberately does not forward the underlying message: the failing call
      // had the card in its arguments, and an error string is a read path like
      // any other.
      void error;
      throw new GatewayVerbError(
        'Storing the card failed. Nothing was saved.',
        'INTERNAL_ERROR',
        500,
      );
    }
    return { card: sanitizeCardMetadata(card) };
  };
}

export function createPaymentsCardsDeleteHandler(service: PaymentsGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const id = readString(params['id'], 'id');
    const result = await service.deleteCard(id);
    return { id, deleted: result.deleted, secretsCleared: result.secretsCleared };
  };
}

function readStringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new GatewayVerbError(`${field} must be an array of strings.`, 'INVALID_ARGUMENT', 400, field);
  return value.map((entry, index) => readString(entry, `${field}[${String(index)}]`));
}

function readObjectArray(value: unknown, field: string, required: boolean): readonly Record<string, unknown>[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || (required && value.length === 0)) {
    throw new GatewayVerbError(`${field} is required and must be a non-empty array.`, 'INVALID_ARGUMENT', 400, field);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new GatewayVerbError(`${field}[${String(index)}] must be an object.`, 'INVALID_ARGUMENT', 400, `${field}[${String(index)}]`);
    }
    return entry as Record<string, unknown>;
  });
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * `payments.checkout.begin`.
 *
 * Validates shape and nothing else. Every judgement about MEANING, whether an
 * amount parses, whether the cart matches, whether the budget covers it, is
 * the service's, because those are the decisions that must not be reachable by
 * a caller that skipped this route.
 */
export function createPaymentsCheckoutBeginHandler(service: PaymentsGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);

    const requestedLines = readObjectArray(params['requestedLines'], 'requestedLines', true).map((entry, index) => ({
      label: readString(entry['label'], `requestedLines[${String(index)}].label`),
      quantity: readInteger(entry['quantity'], `requestedLines[${String(index)}].quantity`),
    }));

    const lines = readObjectArray(params['lines'], 'lines', true).map((entry, index) => ({
      label: readString(entry['label'], `lines[${String(index)}].label`),
      quantity: readString(entry['quantity'], `lines[${String(index)}].quantity`),
      unitPrice: readString(entry['unitPrice'], `lines[${String(index)}].unitPrice`),
    }));

    const fees = readObjectArray(params['fees'], 'fees', false).map((entry, index) => ({
      label: readString(entry['label'], `fees[${String(index)}].label`),
      amount: readString(entry['amount'], `fees[${String(index)}].amount`),
    }));

    const shippingOptions = readObjectArray(params['shippingOptions'], 'shippingOptions', true).map((entry, index) => ({
      label: readString(entry['label'], `shippingOptions[${String(index)}].label`),
      cost: readString(entry['cost'], `shippingOptions[${String(index)}].cost`),
    }));

    const cardFields = readObjectArray(params['cardFields'], 'cardFields', true).map((entry, index) => ({
      field: readString(entry['field'], `cardFields[${String(index)}].field`),
      ref: readString(entry['ref'], `cardFields[${String(index)}].ref`),
    }));

    const addressFields = readObjectArray(params['addressFields'], 'addressFields', false).map((entry, index) => ({
      kind: readString(entry['kind'], `addressFields[${String(index)}].kind`),
      field: readString(entry['field'], `addressFields[${String(index)}].field`),
      ref: readString(entry['ref'], `addressFields[${String(index)}].ref`),
    }));

    const twoDigit = params['twoDigitYear'];
    const requestId = readString(params['requestId'], 'requestId');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestId)) {
      throw new GatewayVerbError('requestId must be a stable checkout identity of 1–128 letters, digits, dots, colons, underscores or hyphens.', 'INVALID_ARGUMENT', 400, 'requestId');
    }
    const result = await service.beginCheckout({
      requestId,
      sessionId: readString(params['sessionId'], 'sessionId'),
      pageId: readString(params['pageId'], 'pageId'),
      merchantDomain: readString(params['merchantDomain'], 'merchantDomain'),
      checkoutUrl: readString(params['checkoutUrl'], 'checkoutUrl'),
      item: readString(params['item'], 'item'),
      cardId: readString(params['cardId'], 'cardId'),
      requestedLines,
      reading: {
        lines,
        tax: optionalString(params['tax']),
        fees,
        shippingOptions,
        statedTotal: optionalString(params['statedTotal']),
        currency: optionalString(params['currency']),
        orderSummaryText: typeof params['orderSummaryText'] === 'string' ? params['orderSummaryText'] : '',
      },
      controls: {
        cardFields,
        addressFields,
        shippingTargets: readStringArray(params['shippingTargets'], 'shippingTargets'),
        placeOrderTarget: readString(params['placeOrderTarget'], 'placeOrderTarget'),
        expirySeparator: optionalString(params['expirySeparator']) ?? undefined,
        twoDigitYear: typeof twoDigit === 'boolean' ? twoDigit : undefined,
      },
      preferredTier: optionalString(params['preferredTier']) ?? undefined,
      requestedMax: params['requestedMax'] === undefined ? undefined : readString(params['requestedMax'], 'requestedMax'),
    });

    return {
      outcome: String(result.outcome),
      purchaseId: result.purchaseId ?? null,
      reason: result.reason ?? null,
      merchantOrderId: result.merchantOrderId ?? null,
      totalMinorUnits: result.totalMinorUnits ?? null,
      currency: result.currency ?? null,
      shippingTierUsed: result.shippingTierUsed ?? null,
      steppedDown: result.steppedDown === true,
      challengeStep: result.challengeStep ?? null,
    };
  };
}

export function createPaymentsPurchasesListHandler(service: PaymentsGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const parsedLimit = readOptionalPositiveInteger(params['limit']);
    const limit = parsedLimit !== undefined ? Math.min(parsedLimit, 500) : 100;
    const rawDay = params['dayKey'];
    const result = await service.listPurchases({
      limit,
      dayKey: typeof rawDay === 'string' && rawDay.trim().length > 0 ? rawDay.trim() : undefined,
    });
    return { purchases: result.purchases, total: result.total,
      ...(result.reconciliations === undefined ? {} : { reconciliations: result.reconciliations }) };
  };
}

/**
 * Attach the payment handlers to their registered descriptors (missing = no-op).
 *
 * Boot recovery runs TO COMPLETION before any handler attaches, so no checkout
 * verb can start a purchase the sweep would then read as interrupted. The
 * promise resolves once the verbs are attached; a caller that does not await
 * it serves the payment verbs a beat later, never a swept-mid-flight checkout.
 * Recovery failure, thrown synchronously or rejected, is reported through
 * `onRecoveryFailure` and does not withhold the verbs: the sweep is a
 * disclosure duty, not a serving precondition once it has stopped running.
 */
export async function registerPaymentsGatewayMethods(
  catalog: GatewayMethodCatalog,
  service: PaymentsGatewayService,
  options: {
    /** Reported when boot recovery itself fails; never carries a notice body. */
    readonly onRecoveryFailure?: ((error: unknown) => void) | undefined;
    /**
     * Receives the sweep envelope every time recovery runs, including a
     * skipped-not-leader boot, for the composition's audit log; disclosure
     * of recoveries is the platform rule, and the envelope is the audit
     * record.
     */
    readonly onRecoverySettled?: ((sweep: unknown) => void) | undefined;
  } = {},
): Promise<void> {
  if (typeof service.recoverInterruptedCheckouts === 'function') {
    try {
      const sweep = await service.recoverInterruptedCheckouts();
      options.onRecoverySettled?.(sweep);
    } catch (error) {
      // Covers both a rejected promise and a synchronous throw from the call.
      options.onRecoveryFailure?.(error);
    }
  }
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };
  attach('payments.budget.status', createPaymentsBudgetStatusHandler(service));
  attach('payments.cards.list', createPaymentsCardsListHandler(service));
  attach('payments.cards.create', createPaymentsCardsCreateHandler(service));
  attach('payments.cards.delete', createPaymentsCardsDeleteHandler(service));
  attach('payments.checkout.begin', createPaymentsCheckoutBeginHandler(service));
  attach('payments.purchases.list', createPaymentsPurchasesListHandler(service));
}
