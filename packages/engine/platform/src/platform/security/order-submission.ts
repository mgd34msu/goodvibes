/**
 * Order placement through the ordinary browser tools.
 *
 * A purchase is budgeted only when it runs as `payments.checkout.begin`: that
 * is where the owner's limits, the notice and the purchase record live. A
 * merchant's saved payment method lets a page take an order with one click,
 * so a control whose own label says it places an order is refused to every
 * caller except the payment flow, whatever its markup (submit button, plain
 * button, link, scripted role=button), and so is Enter or a submit in a form
 * whose default submit control says so. The refusal names the path that
 * applies the limits. A control whose label does not say so is not recognised,
 * and nothing claims such a click was budgeted.
 */

/** Labels a control uses to take an order and charge for it. */
const ORDER_LABEL = /\b(?:place|submit|complete|confirm|finish)\s+(?:my\s+|your\s+|the\s+)?(?:order|purchase|payment)\b|\b(?:buy|order|pay|checkout|check\s+out)\s+now\b|\bpay\s+(?:with|by|using|securely)\b|^\s*(?:pay|buy|purchase)\s*(?:[$€£¥₹]|[A-Z]{3}\b|\d|$)|\bconfirm\s+and\s+pay\b|\bsubscribe\s+and\s+pay\b/iu;
/**
 * The same labels in the other languages merchants commonly check out in
 * (German, French, Spanish, Italian, Dutch, Portuguese). German law requires
 * the order button to read "zahlungspflichtig bestellen" or an equivalent.
 */
const ORDER_LABEL_OTHER = /\b(?:zahlungspflichtig|kostenpflichtig)\s+(?:bestellen|abschlie(?:ß|ss)en|buchen)\b|\bjetzt\s+(?:kaufen|bezahlen)\b|\bkaufen\s+und\s+bezahlen\b|\b(?:valider|confirmer|passer)\s+(?:la|ma)\s+commande\b|\b(?:acheter|payer)\s+maintenant\b|\bcommander\s+et\s+payer\b|\b(?:realizar|confirmar|finalizar|tramitar)\s+(?:el\s+|mi\s+)?(?:pedido|compra|pago)\b|\b(?:comprar|pagar)\s+(?:ahora|agora|ya)\b|\b(?:conferma|completa)\s+(?:l'|l’)?(?:ordine|acquisto)\b|\b(?:acquista|paga)\s+ora\b|\b(?:nu\s+kopen|nu\s+betalen|bestellen\s+en\s+betalen|bestelling\s+plaatsen)\b|\bfinalizar\s+(?:a\s+)?(?:encomenda|compra)\b/iu;
/** Phrases that, on a link, only lead to the checkout page rather than take the order. */
const CHECKOUT_ENTRY = /\b(?:checkout|check\s+out)\s+now\b/iu;

const paymentFlowActions = new WeakSet<object>();

/** The payment flow marks the ownership object of the one click it submits an order with. */
export function markPaymentCheckoutAction(ownership: object): void { paymentFlowActions.add(ownership); }

/** Whether this click belongs to the payment flow's own submit. */
export function isPaymentCheckoutAction(ownership: object | undefined): boolean {
  return ownership !== undefined && paymentFlowActions.has(ownership);
}

/**
 * Whether a control's label says that activating it places an order. Code
 * only; no page reading. A link labelled only "Checkout now" goes to the
 * checkout, where the order itself is placed through the payment flow.
 */
export function placesOrder(element: { readonly name: string; readonly role?: string | undefined }): boolean {
  const label = element.name.normalize('NFKC');
  if (!ORDER_LABEL.test(label) && !ORDER_LABEL_OTHER.test(label)) return false;
  if (element.role === 'link' && CHECKOUT_ENTRY.test(label)) {
    return ORDER_LABEL.test(label.replace(CHECKOUT_ENTRY, ' ')) || ORDER_LABEL_OTHER.test(label);
  }
  return true;
}

export const ORDER_SUBMIT_REFUSAL_FIX = 'Read the checkout and start the purchase with payments.checkout.begin (merchant, item, lines, delivery options and the place-order ref); the daemon applies your spending limits, tells you, and clicks it once.';
