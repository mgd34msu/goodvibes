/**
 * routes/payments.ts, the wire shapes of the `payments.*` verbs.
 *
 * The daemon's payments host (`payments/host/register.ts`) is the one
 * registrar: it attaches every `payments.*` handler, builds each card view from
 * named fields, and never forwards the message of a call that had card
 * material in its arguments. This module holds the types that registrar and
 * its service share, and `createPaymentsCheckoutBeginHandler`, a context-free
 * begin over the same service that the live payments proof drives; no shipped
 * registrar attaches it.
 */
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
  /** The owner's standing authorisation a scheduled or triggered purchase ran under; absent otherwise. */
  readonly standingAuthorizationId?: string;
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
