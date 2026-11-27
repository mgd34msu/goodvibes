/**
 * Browser-safe payment UI policy. No card scanning, judgment runtime, stores,
 * credentials or checkout execution is reachable through this entry point.
 * The daemon remains responsible for enforcing card-entry and payment gates.
 */
export {
  mayEnterCardDetails,
  mayOfferCardEntryFlow,
  describeCardEntryRefusal,
  describeCardTransportRefusal,
  mayCrossWithCardDetails,
} from './entry-policy.js';
export type { CardEntryTransport } from './entry-policy.js';
export { PAYMENTS_SYNTHETIC_CONFIG_KEYS } from '../config/payment-config-keys.js';
export { minorUnitExponent } from './money-parsing.js';
export { formatMinorUnits, readPurchaseNoticeRow, type PurchaseNoticeRow } from './message.js';
// The Money place's declaration reads currency codes too (terminal-shell places/money-place.ts, drawn by the web UI).
export { parseCurrencyCode } from './types.js';
export { readPaymentWindowStatus, readPaymentWindowAnswer, readPaymentSecurityCodeAcceptance } from './window-view.js';
export type { PaymentWindowView, PaymentWindowAnswer, PaymentPurchaseStatus, PaymentUnreadableOperation, PaymentSecurityCodeRequestView, PaymentSecurityCodeAcceptance, PaymentHostStopView } from './window-view.js';

/**
 * What every surface must show at the moment someone selects
 * `payments.cvvHandling: 'prompt'`.
 *
 * The wording lives here rather than in each surface so it cannot drift, and it
 * is shown at the point of SELECTION rather than in a document, because a
 * trade-off this large belongs in front of whoever is flipping the switch.
 *
 * Note what this is not: it is not a warning against storing the CVV. Storing it
 * is the owner's settled ruling and the default. This is the honest consequence
 * of choosing the other value.
 */
export const CVV_PROMPT_TRADEOFF_WARNING =
  'Choosing "prompt" stops unattended purchasing. The card verification value will not be '
  + 'stored: when a purchase is approved and reaches payment, you are asked to type the code in '
  + 'the terminal app or the Agent (Waiting for you, under Purchases) or the local web UI, and the purchase waits for it as long '
  + 'as an approval window. If it is not typed in time, nothing is bought, including purchases that '
  + 'are within budget and would otherwise have gone ahead on their own. Never send the code in a chat.';


/** One way purchases may run once payments are on: `payments.confirmEveryPurchase` true (`ask`) or false (`veto`). */
export interface PurchaseModeChoice {
  readonly id: 'ask' | 'veto';
  readonly confirmEveryPurchase: boolean;
  readonly label: string;
  /** What it means, in one line. */
  readonly detail: string;
}

/**
 * The two ways purchases can run, as every surface offers them where payments
 * are turned on. The words live here so the terminal programs and the web UI
 * say the same thing. The first is marked as the recommended, safer way. The second line states what happens when the stop notice
 * cannot reach the owner, their recorded decision (docs/payments.md, the ruling on
 * undeliverable notices), so it is known at the moment it is chosen.
 */
export function purchaseModeChoices(vetoMinutes: number): readonly PurchaseModeChoice[] {
  const minutes = Number.isFinite(vetoMinutes) && vetoMinutes > 0 ? Math.round(vetoMinutes) : 10;
  return [
    {
      id: 'ask',
      confirmEveryPurchase: true,
      label: 'Ask me before every purchase (recommended)',
      detail: 'The safer way: nothing is bought until you approve it, naming the shop, the item and the most it may cost.',
    },
    {
      id: 'veto',
      confirmEveryPurchase: false,
      label: `Buy, and give me ${minutes} minute${minutes === 1 ? '' : 's'} to stop it`,
      detail: `A purchase within your budgets at a shop you can get your money back from goes ahead unless you say stop within ${minutes} minute${minutes === 1 ? '' : 's'}; if the notice cannot reach you, it still goes ahead.`,
    },
  ];
}

export { readPaymentOperation, readPaymentOperationCancellation, paymentOperationDescription, isLivePaymentOperation, canReconcilePaymentOperation, purchaseDisposition, readPurchaseOutcome, PAYMENT_PURCHASE_RECONCILE_HTTP } from './operation-view.js';
export type { PaymentOperationView, PaymentOperationState, PaymentOperationCancellation, PaymentOperationLimit, PurchaseDisposition, PurchaseOutcome, PaymentReconciliationFinding } from './operation-view.js';
