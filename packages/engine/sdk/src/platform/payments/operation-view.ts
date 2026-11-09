/** Public operation metadata. No credential, card, page reading or execution
 * capability is part of this view. A stored status never authorizes a submit. */
export const PAYMENT_OPERATION_STATES = ['accepted', 'running', 'cancelling', 'completed', 'refused', 'cancelled', 'attention', 'interrupted', 'uncertain', 'failed'] as const;
export type PaymentOperationState = typeof PAYMENT_OPERATION_STATES[number];
/** Shared with the catalog and browser client before generated facade refresh. */
export const PAYMENT_PURCHASE_RECONCILE_HTTP = { method: 'POST', path: '/api/payments/purchase/reconcile' } as const;
export interface PaymentOperationView {
  readonly purchaseId: string;
  readonly operationId: string;
  readonly state: PaymentOperationState;
  readonly phase: 'deciding' | 'awaiting-window' | 'arming-payment' | 'submit-pending' | 'submitted' | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly outcome: string | null;
  readonly totalMinorUnits: number | null;
  readonly currency: string | null;
}
export interface PaymentOperationCancellation {
  readonly purchaseId: string;
  readonly operationId: string;
  readonly accepted: true;
  readonly mayHaveSubmitted: boolean;
}
export function isLivePaymentOperation(state: PaymentOperationState): boolean {
  return state === 'accepted' || state === 'running' || state === 'cancelling';
}
/** A current paired owner must inspect merchant history first. These controls
 * settle original bookkeeping only; they never resume a browser submission. */
export function canReconcilePaymentOperation(operation: PaymentOperationView): boolean {
  return !isLivePaymentOperation(operation.state)
    && (operation.state === 'uncertain' || operation.state === 'attention'
      || (operation.state === 'completed' && operation.outcome === 'submitted-unverified'));
}
const REFUSAL_MESSAGES: Readonly<Record<string, string>> = {
  'disabled': 'Payments are disabled or this daemon is not the elected payment host.',
  'recovery-unavailable': 'The original checkout could not be restored. Check its paired owner, payment settings, original browser and reply channel before starting a new checkout.',
  'no-card': 'No usable payment card is configured. Check the card in payment settings.',
  'no-shipping-address': 'The stored address is incomplete, unavailable or changed. Check payment address settings.',
  'not-owner-request': 'The checkout did not have a direct request from its owner.',
  'derived-from-untrusted-content': 'The purchase instruction repeats untrusted content, or its original source evidence is incomplete. Make a fresh request in your own words.',
  'link-validation-failed': 'The checkout address did not pass the authorized merchant checks.',
  'currency-mismatch': 'The checkout currency does not match the payment budget.',
  'recurring-charge': 'The checkout would create a recurring charge.',
  'invalid-requested-maximum': 'The requested maximum is invalid. Use one non-negative decimal amount in the budget currency, without grouping or prose.',
  'requested-maximum-exceeded-undeliverable': 'The full purchase total exceeded your requested maximum and its approval notice could not be delivered. Nothing was bought.',
  'requested-maximum-exceeded-denied': 'Spending above your requested maximum was denied. Nothing was bought.',
  'requested-maximum-exceeded-expired': 'Approval to exceed your requested maximum expired without an answer. Nothing was bought.',
  'item-budget-exceeded-undeliverable': 'The purchase exceeded its budget and its approval notice could not be delivered.',
  'item-budget-exceeded-denied': 'The above-budget purchase was denied.',
  'item-budget-exceeded-expired': 'The above-budget approval expired without approval.',
  'per-purchase-ceiling-exceeded': 'The purchase exceeded the configured per-purchase ceiling.',
  'overage-pool-exhausted': 'The overage budget could not cover tax, fees and delivery.',
  'zero-budget': 'No spending budget is configured.',
  'total-changed': 'The checkout total or delivery selection changed before payment.',
  'challenge-abandoned': 'Merchant verification could not be completed. Check merchant order history before retrying.',
  'submit-not-attempted': 'The final submission checks refused before a merchant click.',
  'cart-mismatch': 'The checkout cart did not match the requested items.',
  'extraction-failed': 'The checkout amounts could not be read unambiguously.',
  'listing-not-purchasable': 'The listing was not confirmed as a supported fixed-price purchase.',
  'merchant-not-recognised-denied': 'The purchase at an unrecognised merchant was denied.',
  'merchant-not-recognised-expired': 'Approval for the unrecognised merchant expired.',
  'merchant-not-recognised-undeliverable': 'Approval for the unrecognised merchant could not be delivered.',
};
export function paymentOperationDescription(operation: PaymentOperationView): string {
  if (operation.outcome === 'owner-confirmed-purchased') return 'You confirmed this order in the merchant’s history. Original payment accounting is settled; no new order was submitted.';
  if (operation.outcome === 'owner-confirmed-not-purchased') return 'You confirmed no order was placed. The original unspent hold was released; any already committed spend remains recorded without crediting a budget. No new order was submitted.';
  if (operation.outcome?.startsWith('owner-reconciliation-pending-')) return 'Your merchant-history finding was saved, but payment bookkeeping has not finished. Refresh and repeat that same finding; do not place another order.';
  switch (operation.state) {
    case 'accepted': return 'Accepted for processing. No purchase outcome has been recorded yet.';
    case 'running': return 'The daemon is processing this checkout. Review any purchase notice before answering.';
    case 'cancelling': return 'Stopping was requested. Wait for final status; this does not undo a merchant submission.';
    case 'completed': return operation.outcome === 'submitted-unverified'
      ? 'Submission was recorded without merchant confirmation. Check the merchant’s order history.' : 'The purchase outcome is recorded in purchase history.';
    case 'refused': return REFUSAL_MESSAGES[operation.outcome?.replace(/^refused:/, '') ?? '']
      ?? 'The checkout was refused. Review the checkout and payment settings before requesting another purchase.';
    case 'cancelled': return 'The checkout stopped before submission.';
    case 'attention': return 'The merchant requested verification. Inspect the original payment page; the daemon will not submit again.';
    case 'interrupted': return 'This operation was interrupted before a final result. Review its payment evidence before starting a fresh checkout.';
    case 'uncertain': return 'Submission or its recording is uncertain. Check purchase history and the merchant before taking further action. The daemon will not retry it.';
    case 'failed': return operation.outcome === 'decision-unavailable'
      ? 'No decision models are currently available. Check provider keys, endpoints, model access and any local model service, then review this checkout before starting a new one.'
      : operation.outcome === 'refused:reply-history-unavailable'
        ? 'The purchase reply could not be saved. Receiving stopped before confirming its cursor. Inspect payment and channel status before starting another checkout.'
      : operation.outcome === 'refused:receive-uncovered'
        ? 'The purchase stopped because its original reply receive span could not be confirmed. Check skipped updates, competing bot consumers and the system clock. Unattended expiry requires the native polling receiver; explicit owner replies remain separate.'
      : operation.outcome === 'refused:receive-unrecorded'
        ? 'The purchase stopped because its completed reply receive span could not be saved. Inspect payment storage and the original purchase status before starting another checkout.'
      : operation.outcome === 'reply-source-unavailable'
        ? 'The purchase reply channel could not be verified. Check Telegram polling or webhook registration and bot account settings, or use the paired host’s Payments controls for a new checkout.'
      : operation.outcome === 'decision-disabled'
        ? 'Automated checkout requires decision models. Review the selected decision policy and this checkout before starting a new one.'
        : 'Processing stopped without a confirmed final outcome. Inspect the payment evidence before retrying.';
  }
}

export function readPaymentOperation(value: unknown): PaymentOperationView {
  const fail = (): never => { throw new Error('The daemon returned invalid purchase-operation status. Refresh before taking action.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  const keys = ['purchaseId', 'operationId', 'state', 'phase', 'createdAtMs', 'updatedAtMs', 'outcome', 'totalMinorUnits', 'currency'];
  if (Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key))
    || typeof row['purchaseId'] !== 'string' || !row['purchaseId'] || row['purchaseId'].length > 256
    || typeof row['operationId'] !== 'string' || !row['operationId'] || row['operationId'].length > 256
    || typeof row['state'] !== 'string' || !(PAYMENT_OPERATION_STATES as readonly string[]).includes(row['state'])
    || !(row['phase'] === null || (typeof row['phase'] === 'string' && ['deciding', 'awaiting-window', 'arming-payment', 'submit-pending', 'submitted'].includes(row['phase'])))
    || !['createdAtMs', 'updatedAtMs'].every(key => typeof row[key] === 'number' && Number.isSafeInteger(row[key]) && row[key] >= 0 && row[key] <= 8_640_000_000_000_000)
    || !(row['outcome'] === null || (typeof row['outcome'] === 'string' && /^(?:purchased|submitted-unverified|refunded|owner-(?:confirmed|reconciliation-pending)-(?:purchased|not-purchased)|refused(?::[a-z-]+)?|cancelled|decision-unavailable|decision-disabled|reply-source-unavailable|challenge:(?:3d-secure|captcha|otp|unknown))$/.test(row['outcome'])))
    || !(row['totalMinorUnits'] === null || (typeof row['totalMinorUnits'] === 'number' && Number.isSafeInteger(row['totalMinorUnits']) && row['totalMinorUnits'] >= 0))
    || !(row['currency'] === null || (typeof row['currency'] === 'string' && /^[A-Z]{3}$/.test(row['currency'])))) return fail();
  return Object.freeze({ purchaseId: row['purchaseId'], operationId: row['operationId'], state: row['state'] as PaymentOperationState,
    phase: row['phase'] as PaymentOperationView['phase'], createdAtMs: row['createdAtMs'] as number, updatedAtMs: row['updatedAtMs'] as number,
    outcome: row['outcome'] as string | null, totalMinorUnits: row['totalMinorUnits'] as number | null, currency: row['currency'] as string | null });
}
export function readPaymentOperationCancellation(value: unknown): PaymentOperationCancellation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid purchase stop acknowledgement. Refresh status.');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 4 || typeof row['purchaseId'] !== 'string' || !row['purchaseId'].trim() || row['purchaseId'].length > 256
    || typeof row['operationId'] !== 'string' || !row['operationId'].trim() || row['operationId'].length > 256 || row['accepted'] !== true || typeof row['mayHaveSubmitted'] !== 'boolean') {
    throw new Error('Invalid purchase stop acknowledgement. Refresh status.');
  }
  return Object.freeze({ purchaseId: row['purchaseId'], operationId: row['operationId'], accepted: true, mayHaveSubmitted: row['mayHaveSubmitted'] });
}
