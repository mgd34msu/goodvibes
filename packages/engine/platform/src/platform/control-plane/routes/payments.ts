/**
 * routes/payments.ts, the wire shapes of the `payments.*` verbs.
 *
 * The daemon's payments host (`payments/host/register.ts`) is the one
 * registrar: it attaches every `payments.*` handler, builds each card view from
 * named fields, and never forwards the message of a call that had card
 * material in its arguments. This module holds the types that registrar and
 * its service share. `payments.checkout.begin` is the host's own handler
 * (payments/host/checkout-handlers.ts): it needs the invocation's paired owner,
 * which no service call carries.
 */
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
  listPurchases(input: { readonly limit: number; readonly dayKey: string | undefined }):
    Promise<{ purchases: readonly PaymentPurchaseView[]; total: number; reconciliations?: readonly {
      readonly purchaseId: string; readonly operationId: string; readonly outcome: 'purchased' | 'not-purchased';
      readonly principalId: string; readonly atMs: number; readonly merchantDomain: string; readonly totalMinorUnits: number; readonly currency: string;
    }[] }>;
}
