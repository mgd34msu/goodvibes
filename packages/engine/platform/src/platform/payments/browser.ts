/**
 * Browser-safe payment UI policy. No card scanning, judgment runtime, stores,
 * credentials or checkout execution is reachable through this entry point.
 * The daemon remains responsible for enforcing card-entry and payment gates.
 */
export {
  mayEnterCardDetails,
  mayOfferCardEntryFlow,
  describeCardEntryRefusal,
} from './entry-policy.js';
export { PAYMENTS_SYNTHETIC_CONFIG_KEYS } from '../config/payment-config-keys.js';
export { minorUnitExponent } from './money-parsing.js';
export { readPaymentWindowStatus, readPaymentWindowAnswer } from './window-view.js';
export type { PaymentWindowView, PaymentWindowAnswer, PaymentPurchaseStatus, PaymentUnreadableOperation } from './window-view.js';

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
  'Choosing "prompt" disables unattended purchasing. The card verification value will not be '
  + 'stored, and there is not yet a place to type it at purchase time, so every purchase is '
  + 'refused as having no usable card, including purchases that are within budget and would '
  + 'otherwise have gone ahead on their own. Choose it only to keep purchasing off for the card.';


export { readPaymentOperation, readPaymentOperationCancellation, paymentOperationDescription, isLivePaymentOperation, canReconcilePaymentOperation, PAYMENT_PURCHASE_RECONCILE_HTTP } from './operation-view.js';
export type { PaymentOperationView, PaymentOperationState, PaymentOperationCancellation } from './operation-view.js';
