/**
 * Payment-capability config interfaces. Split out of schema-types.ts so that
 * file stays under its grandfathered line ceiling; re-exported from
 * schema-types.ts so import sites are unchanged.
 *
 * Card MATERIAL is deliberately absent from every type here. The number,
 * expiry, CVV and cardholder name live in the daemon secret store under keys
 * derived by `daemonSecretKeyFor`, never in config, see docs/payments.md §3.
 */

/** Which delivery tier to prefer, ordinal against what a checkout offers. */
export type ShippingTierPreference = 'normal' | 'fast' | 'fastest';

/**
 * How the card verification value is handled.
 *
 * `'stored'` is the default and the owner's ruling: autonomous action requires
 * it, because a purchase that stops to ask for a code is an attended purchase.
 * `'prompt'` disables unattended purchasing, surfaces state that at the moment
 * of selection. See docs/decisions/2026-07-27-the-cvv-is-stored.md.
 */
export type CvvHandling = 'stored' | 'prompt';

export interface PaymentsBudgetConfig {
  dailyItem: number;                    // default: 0
  dailyOverage: number;                 // default: 0
  perPurchaseCeilingEnabled: boolean;   // default: true
  perPurchaseCeiling: number;           // default: 0
  overageToleranceEnabled: boolean;     // default: false
  overageToleranceDailyAllowance: number; // default: 0
}

export interface PaymentsWindowsConfig {
  /** Within budget. Silence PROCEEDS. */
  vetoMinutes: number;      // default: 10
  /** Above budget. Silence DENIES. */
  approvalMinutes: number;  // default: 60
}

/** A postal address, flat so each field is an ordinary config key. */
export interface PaymentsAddressConfig {
  name: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

export interface PaymentsConfig {
  enabled: boolean;                 // default: false. Master switch
  confirmEveryPurchase: boolean;    // default: false. Require an approval ahead of time (payments.approve) before each purchase
  defaultCardId: string;            // default: ''. The card a purchase that names none is paid with
  currency: string;                 // default: 'USD'. ISO-4217 the budgets are denominated in
  cvvHandling: CvvHandling;         // default: 'stored'
  budget: PaymentsBudgetConfig;
  shipping: { preferredTier: ShippingTierPreference };
  /** Checked by the issuer's address verification. */
  billingAddress: PaymentsAddressConfig;
  /** Where purchases go. A purchase is refused while this is incomplete. */
  shippingAddress: PaymentsAddressConfig;
  /** Ordered command-authority channels. Email is never accepted here. */
  notifyChannels: string;           // default: ''
  /** Registrable domains added to / removed from the recognised-retailer list. */
  majorRetailersAdditional: string; // default: ''
  majorRetailersExcluded: string;   // default: ''
  /** eBay per-listing bar; seller-side figures only. */
  ebayMinSellerFeedbackCount: number;   // default: 100
  ebayMinSellerPositivePercent: number; // default: 98
  windows: PaymentsWindowsConfig;
}
