import type { ExecutionRefusalCode, RefusalCode } from './types.js';
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
  /** The specific reason the purchase ended unbought, as the owner was told it. Absent on older records. */
  readonly reason?: string | null;
  /** The verification step (3-D Secure, CAPTCHA, one-time code) waiting on the owner. */
  readonly challengeStep?: string | null;
  /** The limit a refusal names, with its amounts in minor units of `currency`. */
  readonly exceeded?: PaymentOperationLimit | null;
}
/** Which owner limit a purchase did not fit, and by how much. */
export interface PaymentOperationLimit {
  readonly limit: 'daily-item-budget' | 'per-purchase-ceiling' | 'requested-maximum' | 'daily-overage-budget' | 'card-limit';
  readonly setting?: string;
  readonly availableMinorUnits: number;
  readonly neededMinorUnits: number;
  readonly excessMinorUnits: number;
  readonly unset: boolean;
}
const OPERATION_LIMITS = ['daily-item-budget', 'per-purchase-ceiling', 'requested-maximum', 'daily-overage-budget', 'card-limit'];
const MAX_OPERATION_TEXT = 4_000;
export interface PaymentOperationCancellation {
  readonly purchaseId: string;
  readonly operationId: string;
  readonly accepted: true;
  readonly mayHaveSubmitted: boolean;
}
export function isLivePaymentOperation(state: PaymentOperationState): boolean {
  return state === 'accepted' || state === 'running' || state === 'cancelling';
}

/** The owner's finding from the merchant's order history. */
export type PaymentReconciliationFinding = 'purchased' | 'not-purchased';
const CHALLENGE_STEPS = ['3d-secure', 'captcha', 'otp', 'unknown'] as const;
const STOP_CAUSES = ['decision-unavailable', 'decision-disabled', 'reply-source-unavailable'] as const;

/**
 * What a recorded outcome says. Stored records and the wire keep the outcome as
 * text; this is the one place that text is read, so no caller matches a prefix.
 */
export type PurchaseOutcome =
  /** Nothing recorded yet. */
  | { readonly kind: 'none' }
  | { readonly kind: 'purchased' }
  /** Submitted, but the merchant's page showed no confirmation. */
  | { readonly kind: 'submitted-unverified' }
  | { readonly kind: 'refunded' }
  /** The owner's merchant-history finding, saved and settled. */
  | { readonly kind: 'owner-confirmed'; readonly finding: PaymentReconciliationFinding }
  /** The owner's finding is saved; its bookkeeping has not finished. */
  | { readonly kind: 'owner-reconciliation-pending'; readonly finding: PaymentReconciliationFinding }
  /** Stopped before any submission for the reason the code names. */
  | { readonly kind: 'refused'; readonly code: string | null }
  | { readonly kind: 'cancelled' }
  /** The merchant asked for a verification step. */
  | { readonly kind: 'challenge'; readonly step: typeof CHALLENGE_STEPS[number] }
  /** Processing stopped before a decision could be made, for the cause named. */
  | { readonly kind: 'stopped'; readonly cause: typeof STOP_CAUSES[number] };

const NO_OUTCOME: PurchaseOutcome = Object.freeze({ kind: 'none' });
/** Read for text no host writes; `readPaymentOperation` admits none, so this is only a floor. */
const UNREADABLE_OUTCOME: PurchaseOutcome = Object.freeze({ kind: 'refused', code: null });

/** Read a recorded outcome, or null when the text is not one this host writes. */
export function readPurchaseOutcome(text: string | null): PurchaseOutcome | null {
  if (text === null) return NO_OUTCOME;
  if (typeof text !== 'string') return null;
  if (text === 'purchased' || text === 'submitted-unverified' || text === 'refunded' || text === 'cancelled') return { kind: text };
  if (text === 'refused') return { kind: 'refused', code: null };
  if ((STOP_CAUSES as readonly string[]).includes(text)) return { kind: 'stopped', cause: text as typeof STOP_CAUSES[number] };
  const refused = /^refused:([a-z-]+)$/.exec(text);
  if (refused?.[1]) return { kind: 'refused', code: refused[1] };
  const owner = /^owner-(confirmed|reconciliation-pending)-(purchased|not-purchased)$/.exec(text);
  if (owner?.[1] && owner[2]) return { kind: owner[1] === 'confirmed' ? 'owner-confirmed' : 'owner-reconciliation-pending', finding: owner[2] as PaymentReconciliationFinding };
  const challenge = /^challenge:(.+)$/.exec(text);
  if (challenge?.[1] && (CHALLENGE_STEPS as readonly string[]).includes(challenge[1])) return { kind: 'challenge', step: challenge[1] as typeof CHALLENGE_STEPS[number] };
  return null;
}

/** The stored text for an outcome. */
export function purchaseOutcomeText(outcome: PurchaseOutcome): string | null {
  switch (outcome.kind) {
    case 'none': return null;
    case 'purchased': case 'submitted-unverified': case 'refunded': case 'cancelled': return outcome.kind;
    case 'owner-confirmed': case 'owner-reconciliation-pending': return `${outcome.kind}-${outcome.finding}`;
    case 'refused': return outcome.code === null ? 'refused' : `refused:${outcome.code}`;
    case 'challenge': return `challenge:${outcome.step}`;
    case 'stopped': return outcome.cause;
  }
}

/** Every question a reader of a purchase's status asks, answered from one table. */
export interface PurchaseDisposition {
  /** An executor is running it, or a start has not yet recovered it. */
  readonly live: boolean;
  /** Nothing will resume, reconcile or submit it again: its saved request and
   * continuation have no further use, and it leaves the open list. */
  readonly final: boolean;
  /** A crash left it waiting on the owner's reply, so the next start may
   * resume that window under its original authority. */
  readonly resumable: boolean;
  /** The owner may record what the merchant's order history shows. */
  readonly reconcilable: boolean;
  /** Listed among open purchases, however many later purchases follow it. */
  readonly keepListed: boolean;
  /** A start compares it with the journal and the purchase ledger before new purchases run. */
  readonly recheckAtStart: boolean;
  readonly outcome: PurchaseOutcome;
}

/**
 * The one answer to "is this purchase over, and what can still happen to it".
 *
 * `interrupted` is recorded only for a purchase that stopped before any submit
 * phase, so it is final: nothing was sent to the merchant and it will not
 * resume. A window a crash left open is still `running` (or `accepted`) when
 * the next start reads it; that is the resumable case.
 */
export function purchaseDisposition(operation: Pick<PaymentOperationView, 'state' | 'phase' | 'outcome'>): PurchaseDisposition {
  const outcome = readPurchaseOutcome(operation.outcome) ?? UNREADABLE_OUTCOME;
  const live = isLivePaymentOperation(operation.state);
  const unverified = operation.state === 'completed' && outcome.kind === 'submitted-unverified';
  const final = operation.state === 'refused' || operation.state === 'cancelled' || operation.state === 'failed'
    || operation.state === 'interrupted' || (operation.state === 'completed' && !unverified);
  const reconcilable = operation.state === 'uncertain' || operation.state === 'attention' || unverified;
  return Object.freeze({
    live,
    final,
    resumable: (operation.state === 'accepted' || operation.state === 'running') && operation.phase === 'awaiting-window' && outcome.kind === 'none',
    reconcilable,
    keepListed: !final,
    recheckAtStart: live || operation.state === 'uncertain' || operation.state === 'attention',
    outcome,
  });
}

/** A current paired owner must inspect merchant history first. These controls
 * settle original bookkeeping only; they never resume a browser submission. */
export function canReconcilePaymentOperation(operation: PaymentOperationView): boolean {
  return purchaseDisposition(operation).reconcilable;
}

/**
 * The state an executor records when a purchase ends without reaching a
 * submit phase: a refusal is `refused` whichever path recorded it, an owner's
 * stop is `cancelled`, anything else is `failed`.
 */
export function unsubmittedEndState(outcome: string | null): 'refused' | 'cancelled' | 'failed' {
  const kind = readPurchaseOutcome(outcome)?.kind;
  return kind === 'refused' ? 'refused' : kind === 'cancelled' ? 'cancelled' : 'failed';
}

/** Refusals the host records itself, beside the checkout's own codes: the
 * purchase stopped before any submission for the reason named. */
type OperationRefusalCode = 'recovery-unavailable' | 'daemon-stopped' | 'reply-history-unavailable' | 'receive-uncovered'
  | 'receive-unrecorded' | 'reply-unsettled' | 'reply-unreadable' | 'clock-unavailable' | 'window-unavailable' | 'page-in-use';
// Typed by the code unions so a new refusal code is a compile error until it
// has a sentence here; the generic fallback is only for records from elsewhere.
const REFUSAL_MESSAGES: Readonly<Record<RefusalCode | ExecutionRefusalCode | OperationRefusalCode, string>> = {
  'disabled': 'Payments are disabled, or this machine is in a group whose purchases run on another machine (cluster status shows which).',
  'recovery-unavailable': 'The original checkout could not be restored. Check its paired owner, payment settings, original browser and reply channel before starting a new checkout.',
  'no-card': 'No usable payment card is configured, or payments.cvvHandling is set to prompt on a host with no way to ask for the code. Check the card in payment settings, or set payments.cvvHandling to stored.',
  'no-shipping-address': 'The stored address is incomplete, unavailable or changed. Check payment address settings.',
  'no-billing-address': 'No complete billing address is stored. Set it in payment address settings, then start the purchase again.',
  'not-owner-request': 'The checkout had neither a direct request from its owner nor a live standing authorisation of his (Repeat purchases in the Money place).',
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
  'card-limit-exceeded': 'The full purchase total is over the limit declared for the chosen card, so the issuer would decline it. Nothing was bought. Pay with another card, or update the card\'s declared limit.',
  'overage-pool-exhausted': 'The overage budget could not cover tax, fees and delivery.',
  'zero-budget': 'No spending budget is configured.',
  'total-changed': 'The checkout total or delivery selection changed before payment.',
  'challenge-abandoned': 'Merchant verification could not be completed. Check merchant order history before retrying.',
  'submit-not-attempted': 'The final submission checks refused before any click reached the merchant. Nothing was submitted. Check the checkout page, then start the purchase again.',
  'submit-outcome-unknown': 'The order may or may not have been placed. Check your order history at the merchant. The hold is kept and nothing is retried.',
  'cart-mismatch': 'The checkout cart did not match the requested items.',
  'extraction-failed': 'The checkout amounts could not be read unambiguously.',
  'listing-not-purchasable': 'The listing was not confirmed as a supported fixed-price purchase.',
  'merchant-not-recognised-denied': 'The purchase at an unrecognised merchant was denied.',
  'merchant-not-recognised-expired': 'Approval for the unrecognised merchant expired.',
  'merchant-not-recognised-undeliverable': 'Approval for the unrecognised merchant could not be delivered.',
  'card-fill-failed': 'The card could not be entered on the checkout page. Nothing was submitted. Check the card fields named for this checkout, then start the purchase again.',
  'owner-changed': 'The stored address, payment settings, pairing, browser page or decision settings changed while the purchase was running. Nothing was submitted. Review them, then start the purchase again.',
  'notice-unavailable': 'The purchase notice could not be prepared or sent. Nothing was submitted. Check the payment notification channels, then start the purchase again.',
  'answer-unreadable': 'Your answer to the purchase notice could not be read, so it was not taken as silence. Nothing was bought. Check that the owner inbox store is readable, then start the purchase again.',
  'budget-held': 'Another purchase in progress is holding the budget this one needs. Nothing was submitted. Wait for that purchase to finish, then start this one again.',
  'cart-unconfirmed': 'A cart line could not be confirmed as the item you asked for. Nothing was bought. Check the cart, or name the item more exactly, then start the purchase again.',
  'recurring-unconfirmed': 'The checkout could not be confirmed as a single payment. Nothing was bought. Start the purchase again with an order summary that holds only this order.',
  'not-checked-unapproved': 'No decision model was in use, so part of the checkout was not checked, and the purchase was not approved. Nothing was bought.',
  'held-reply-not-understood': 'Your reply to the purchase notice was not taken as a go-ahead, and the follow-up approval got no yes. Nothing was bought.',
  'security-code-not-given': 'The card security code was not typed before the deadline, so nothing was bought. Start the purchase again and type the code with /payments pending when asked.',
  'daemon-stopped': 'The daemon stopped before this purchase was submitted. Nothing was sent to the merchant and it will not resume; start the purchase again if you still want it.',
  'reply-history-unavailable': 'The purchase reply could not be saved. Receiving stopped before confirming its cursor. Nothing was submitted. Inspect payment and channel status before starting another checkout.',
  'receive-uncovered': 'The purchase stopped because its original reply receive span could not be confirmed. Nothing was submitted. Check skipped updates, competing bot consumers and the system clock. Unattended expiry requires the native polling receiver; explicit owner replies remain separate.',
  'receive-unrecorded': 'The purchase stopped because its completed reply receive span could not be saved. Nothing was submitted. Inspect payment storage and the original purchase status before starting another checkout.',
  'reply-unsettled': 'A reply arrived before the window closed but was still being read when it closed, so it was neither used nor treated as silence. Nothing was submitted. Start the purchase again if you still want it.',
  'reply-unreadable': 'A reply to the purchase notice could not be read, so it was neither used nor treated as silence. Nothing was submitted. Check decision model access, then start the purchase again if you still want it.',
  'clock-unavailable': 'The system clock could not be read while the purchase window was open, so the window could not be timed. Nothing was submitted. Check the host clock, then start the purchase again.',
  'window-unavailable': 'The reply window for this purchase could not be opened, or another window replaced it, so you could not be asked. Nothing was submitted. Open /payments pending (or Purchases in the web UI settings) for any purchase already waiting for an answer, then start this one again.',
  'page-in-use': 'This browser page already has a checkout that is running or waiting for a merchant check. Nothing was submitted. Finish or reconcile that purchase, or open the checkout in a new tab.',
};
/** Processing stopped before a decision, for the cause named. */
const STOP_MESSAGES: Readonly<Record<typeof STOP_CAUSES[number], string>> = {
  'decision-unavailable': 'No decision models are currently available. Check provider keys, endpoints, model access and any local model service, then review this checkout before starting a new one.',
  'reply-source-unavailable': 'The purchase reply channel could not be verified. Check Telegram polling or webhook registration and bot account settings, or use the paired host’s Payments controls for a new checkout.',
  'decision-disabled': 'Automated checkout requires decision models. Review the selected decision policy and this checkout before starting a new one.',
};
/** The sentence for a refusal or stop outcome, whichever state recorded it. */
function outcomeMessage(outcome: PurchaseOutcome): string | undefined {
  if (outcome.kind === 'stopped') return STOP_MESSAGES[outcome.cause];
  if (outcome.kind !== 'refused' || outcome.code === null || !Object.hasOwn(REFUSAL_MESSAGES, outcome.code)) return undefined;
  return REFUSAL_MESSAGES[outcome.code as keyof typeof REFUSAL_MESSAGES];
}
export function paymentOperationDescription(operation: PaymentOperationView): string {
  // The sentence the purchase itself composed (which line, which limit and
  // by how much, which step) says more than the generic one for its code.
  if (operation.reason && (operation.state === 'refused' || operation.state === 'attention' || operation.state === 'cancelled')) return operation.reason;
  const { outcome, resumable } = purchaseDisposition(operation);
  if (outcome.kind === 'owner-confirmed') return outcome.finding === 'purchased'
    ? 'You confirmed this order in the merchant’s history. Original payment accounting is settled; no new order was submitted.'
    : 'You confirmed no order was placed. The original unspent hold was released; any already committed spend remains recorded without crediting a budget. No new order was submitted.';
  if (outcome.kind === 'owner-reconciliation-pending') return 'Your merchant-history finding was saved, but payment bookkeeping has not finished. Refresh and repeat that same finding; do not place another order.';
  if (resumable) return 'This purchase is waiting for your answer to its notice. If the daemon restarted meanwhile, it resumes that window once the payment host has recovered, or ends unbought and tells you why.';
  switch (operation.state) {
    case 'accepted': return 'Accepted for processing. No purchase outcome has been recorded yet.';
    case 'running': return 'The daemon is processing this checkout. Review any purchase notice before answering.';
    case 'cancelling': return 'Stopping was requested. Wait for final status; this does not undo a merchant submission.';
    case 'completed': return outcome.kind === 'submitted-unverified'
      ? 'The merchant’s page showed no order confirmation after the submit, so the submission was recorded as unverified. A matching confirmation email from the shop marks it bought; otherwise check the merchant’s order history, then record what you found.' : 'The purchase outcome is recorded in purchase history.';
    case 'refused': return outcomeMessage(outcome)
      ?? 'The checkout was refused. Review the checkout and payment settings before requesting another purchase.';
    case 'cancelled': return 'The checkout was stopped before submission. Nothing was sent to the merchant.';
    case 'attention': return 'The merchant requested verification. Inspect the original payment page; the daemon will not submit again.';
    // Recorded only before any submit phase.
    case 'interrupted': return outcome.kind === 'cancelled' ? 'The checkout was stopped before submission. Nothing was sent to the merchant.'
      : outcomeMessage(outcome) ?? REFUSAL_MESSAGES['daemon-stopped'];
    case 'uncertain': return 'Submission or its recording is uncertain. Check purchase history and the merchant before taking further action. The daemon will not retry it.';
    case 'failed': return outcomeMessage(outcome)
      ?? 'Processing stopped without a confirmed final outcome. Nothing was submitted. Read the payment evidence before retrying.';
  }
}

export function readPaymentOperation(value: unknown): PaymentOperationView {
  const fail = (): never => { throw new Error('The daemon returned invalid purchase-operation status. Refresh before taking action.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  const keys = ['purchaseId', 'operationId', 'state', 'phase', 'createdAtMs', 'updatedAtMs', 'outcome', 'totalMinorUnits', 'currency'];
  const optional = ['reason', 'challengeStep', 'exceeded'];
  const text = (value: unknown): boolean => value === undefined || value === null || (typeof value === 'string' && value.length > 0 && value.length <= MAX_OPERATION_TEXT);
  if (keys.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !keys.includes(key) && !optional.includes(key))
    || !text(row['reason']) || !text(row['challengeStep']) || !(row['exceeded'] === undefined || row['exceeded'] === null || readOperationLimit(row['exceeded']) !== null)
    || typeof row['purchaseId'] !== 'string' || !row['purchaseId'] || row['purchaseId'].length > 256
    || typeof row['operationId'] !== 'string' || !row['operationId'] || row['operationId'].length > 256
    || typeof row['state'] !== 'string' || !(PAYMENT_OPERATION_STATES as readonly string[]).includes(row['state'])
    || !(row['phase'] === null || (typeof row['phase'] === 'string' && ['deciding', 'awaiting-window', 'arming-payment', 'submit-pending', 'submitted'].includes(row['phase'])))
    || !['createdAtMs', 'updatedAtMs'].every(key => typeof row[key] === 'number' && Number.isSafeInteger(row[key]) && row[key] >= 0 && row[key] <= 8_640_000_000_000_000)
    || !(row['outcome'] === null || (typeof row['outcome'] === 'string' && row['outcome'].length <= 256 && readPurchaseOutcome(row['outcome']) !== null))
    || !(row['totalMinorUnits'] === null || (typeof row['totalMinorUnits'] === 'number' && Number.isSafeInteger(row['totalMinorUnits']) && row['totalMinorUnits'] >= 0))
    || !(row['currency'] === null || (typeof row['currency'] === 'string' && /^[A-Z]{3}$/.test(row['currency'])))) return fail();
  const exceeded = row['exceeded'] === undefined || row['exceeded'] === null ? null : readOperationLimit(row['exceeded']);
  return Object.freeze({ purchaseId: row['purchaseId'], operationId: row['operationId'], state: row['state'] as PaymentOperationState,
    phase: row['phase'] as PaymentOperationView['phase'], createdAtMs: row['createdAtMs'] as number, updatedAtMs: row['updatedAtMs'] as number,
    outcome: row['outcome'] as string | null, totalMinorUnits: row['totalMinorUnits'] as number | null, currency: row['currency'] as string | null,
    ...(typeof row['reason'] === 'string' ? { reason: row['reason'] } : {}),
    ...(typeof row['challengeStep'] === 'string' ? { challengeStep: row['challengeStep'] } : {}),
    ...(exceeded ? { exceeded } : {}) });
}
function readOperationLimit(value: unknown): PaymentOperationLimit | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const amount = (key: string): boolean => typeof row[key] === 'number' && Number.isSafeInteger(row[key]) && (row[key] as number) >= 0;
  if (Object.keys(row).some(key => !['limit', 'setting', 'availableMinorUnits', 'neededMinorUnits', 'excessMinorUnits', 'unset'].includes(key))
    || typeof row['limit'] !== 'string' || !OPERATION_LIMITS.includes(row['limit'])
    || !(row['setting'] === undefined || (typeof row['setting'] === 'string' && /^payments\.[a-zA-Z.]{1,80}$/.test(row['setting'])))
    || !amount('availableMinorUnits') || !amount('neededMinorUnits') || !amount('excessMinorUnits') || typeof row['unset'] !== 'boolean') return null;
  return Object.freeze({ limit: row['limit'] as PaymentOperationLimit['limit'], ...(typeof row['setting'] === 'string' ? { setting: row['setting'] } : {}),
    availableMinorUnits: row['availableMinorUnits'] as number, neededMinorUnits: row['neededMinorUnits'] as number,
    excessMinorUnits: row['excessMinorUnits'] as number, unset: row['unset'] as boolean });
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
