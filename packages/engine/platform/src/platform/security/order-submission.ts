/**
 * Order placement through the ordinary browser tools.
 *
 * A purchase is budgeted only when it runs as `payments.checkout.begin`: that
 * is where the owner's limits, the notice and the purchase record live. A
 * merchant's saved payment method lets a page take an order with one click,
 * so a submit control whose own label says it places an order is refused to
 * every caller except the payment flow, and the refusal names the path that
 * applies the limits. A control whose label does not say so is not recognised,
 * and nothing claims such a click was budgeted.
 */

/** Labels a submit control uses to take an order and charge for it. */
const ORDER_LABEL = /\b(?:place|submit|complete|confirm|finish)\s+(?:my\s+|your\s+|the\s+)?(?:order|purchase|payment)\b|\b(?:buy|order|pay|checkout|check\s+out)\s+now\b|\bpay\s+(?:with|by|using|securely)\b|^\s*(?:pay|buy|purchase)\s*(?:[$€£¥₹]|[A-Z]{3}\b|\d|$)|\bconfirm\s+and\s+pay\b|\bsubscribe\s+and\s+pay\b/iu;

const paymentFlowActions = new WeakSet<object>();

/** The payment flow marks the ownership object of the one click it submits an order with. */
export function markPaymentCheckoutAction(ownership: object): void { paymentFlowActions.add(ownership); }

/** Whether this click belongs to the payment flow's own submit. */
export function isPaymentCheckoutAction(ownership: object | undefined): boolean {
  return ownership !== undefined && paymentFlowActions.has(ownership);
}

/** Whether a submit control's label says that activating it places an order. Code only; no page reading. */
export function placesOrder(element: { readonly name: string }): boolean {
  return ORDER_LABEL.test(element.name.normalize('NFKC'));
}

export const ORDER_SUBMIT_REFUSAL_FIX = 'Read the checkout and start the purchase with payments.checkout.begin (merchant, item, lines, delivery options and the place-order ref); the daemon applies your spending limits, tells you, and clicks it once.';
