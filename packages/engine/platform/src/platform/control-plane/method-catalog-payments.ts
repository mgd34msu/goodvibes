/**
 * method-catalog-payments.ts
 *
 * The `payments.*` operator methods the daemon serves. The daemon is the
 * process that holds the card and charges it, with every surface closed and
 * across restarts, so these are the surfaces' only way to see or change any of
 * it.
 *
 * What is deliberately NOT here: any method that returns card material. The
 * number, expiry, CVV and cardholder name go in through `payments.cards.create`
 * and are never readable back over the control plane, `payments.cards.list`
 * answers with metadata and a `materialComplete` flag so a surface can render
 * "CVV not set" without the daemon ever emitting one. See docs/payments.md §3.1.
 *
 * No verb types a card either: the purchase the daemon runs
 * (`payments.checkout.begin`) reads the material in-process and types it, so
 * the model orchestrates the purchase and never holds the instrument.
 *
 * Scopes: reads take `read:payments`, writes take `write:payments`. Card
 * creation and deletion are admin-only, because anything that can rewrite the
 * card can redirect where money goes.
 *
 * Handlers: payments/host/register.ts, the daemon's payments host; wire types in routes/payments.ts.
 */
import { BOOLEAN_SCHEMA, STRING_SCHEMA, methodDescriptor, objectSchema } from './method-catalog-shared.js';
import { IDEMPOTENCY_KEY_REPLAY } from './idempotent-replay.js';
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import { PAYMENT_PURCHASE_RECONCILE_HTTP } from '../payments/operation-view.js';
import {
  PAYMENTS_BUDGET_STATUS_INPUT_SCHEMA,
  PAYMENTS_BUDGET_STATUS_OUTPUT_SCHEMA,
  PAYMENTS_CARDS_CREATE_INPUT_SCHEMA,
  PAYMENTS_CARDS_CREATE_OUTPUT_SCHEMA,
  PAYMENTS_CARDS_DELETE_INPUT_SCHEMA,
  PAYMENTS_CARDS_DELETE_OUTPUT_SCHEMA,
  PAYMENTS_CARDS_LIST_INPUT_SCHEMA,
  PAYMENTS_CARDS_LIST_OUTPUT_SCHEMA,
  PAYMENTS_CHECKOUT_BEGIN_INPUT_SCHEMA,
  PAYMENTS_CHECKOUT_BEGIN_OUTPUT_SCHEMA,
  PAYMENTS_PURCHASES_LIST_INPUT_SCHEMA,
  PAYMENTS_PURCHASES_LIST_OUTPUT_SCHEMA,
  PAYMENTS_PURCHASE_STATUS_INPUT_SCHEMA,
  PAYMENTS_PURCHASE_STATUS_OUTPUT_SCHEMA,
  PAYMENTS_PURCHASE_ANSWER_INPUT_SCHEMA,
  PAYMENTS_PURCHASE_ANSWER_OUTPUT_SCHEMA,
  PAYMENTS_PURCHASE_CANCEL_INPUT_SCHEMA,
  PAYMENTS_PURCHASE_CANCEL_OUTPUT_SCHEMA,
  PAYMENTS_PURCHASE_RECONCILE_INPUT_SCHEMA,
  PAYMENTS_PURCHASE_RECONCILE_OUTPUT_SCHEMA,
  PAYMENTS_PURCHASE_SECURITY_CODE_INPUT_SCHEMA,
  PAYMENTS_PURCHASE_SECURITY_CODE_OUTPUT_SCHEMA,
  PAYMENTS_STANDING_CREATE_INPUT_SCHEMA,
  PAYMENTS_STANDING_CREATE_OUTPUT_SCHEMA,
  PAYMENTS_STANDING_LIST_INPUT_SCHEMA,
  PAYMENTS_STANDING_LIST_OUTPUT_SCHEMA,
  PAYMENTS_STANDING_DELETE_INPUT_SCHEMA,
  PAYMENTS_STANDING_DELETE_OUTPUT_SCHEMA,
} from './operator-contract-schemas-payments.js';

export const builtinGatewayPaymentsMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'payments.purchase.reconcile', title: 'Record the Merchant Order Finding', category: 'payments',
    repeat: 'safe',
    scopes: ['write:payments'], access: 'admin', dangerous: true, ownerOnly: true,
    description: 'After inspecting the merchant’s order history, explicitly record whether this exact uncertain or unverified checkout placed an order. Requires current paired admin authority, write:payments, confirm: true and inspectedMerchantHistory: true. The saved finding cannot be changed by a retry. Settles only original purchase/budget bookkeeping after its actual executor has drained; never submits or resumes an order. Missing local receipts never imply no charge. A no-order finding releases an original unspent hold but never credits already committed spend.',
    http: PAYMENT_PURCHASE_RECONCILE_HTTP,
    inputSchema: PAYMENTS_PURCHASE_RECONCILE_INPUT_SCHEMA, outputSchema: PAYMENTS_PURCHASE_RECONCILE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'payments.purchase.securityCode', title: 'Type the Card Security Code', category: 'payments',
    repeat: 'safe',
    scopes: ['write:payments'], access: 'admin', dangerous: true, ownerOnly: true,
    description: 'Under payments.cvvHandling prompt, hand the card security code the owner typed to the one approved purchase waiting for it, by its exact purchaseId and windowId from payments.purchase.status. Requires an explicit owner action, confirm: true and current paired admin authority with write:payments. The code is used for that purchase\'s card entry and kept nowhere. A closed or replaced request refuses; this never submits directly or overrides any budget, merchant, page or address check.',
    http: { method: 'POST', path: '/api/payments/purchase/security-code' },
    inputSchema: PAYMENTS_PURCHASE_SECURITY_CODE_INPUT_SCHEMA, outputSchema: PAYMENTS_PURCHASE_SECURITY_CODE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'payments.purchase.status', title: 'Purchase Operations and Windows', category: 'payments', scopes: ['read:payments'],
    description: 'Read durable checkout operation status and actual live approval/veto windows, and any approved purchase waiting for its card security code (securityCodes, under payments.cvvHandling prompt). Optionally select one purchase, including after reconnect or restart. An accepted operation is not a completed purchase; uncertain submissions must be checked with the merchant and are never automatically retried. Reading does not extend a deadline or resume execution. Complete purchase records are available through payments.purchases.list.',
    http: { method: 'GET', path: '/api/payments/purchase/status' },
    inputSchema: PAYMENTS_PURCHASE_STATUS_INPUT_SCHEMA, outputSchema: PAYMENTS_PURCHASE_STATUS_OUTPUT_SCHEMA,
  }),
  ...(['approve', 'deny', 'cancel'] as const).map(action => methodDescriptor({
    id: `payments.purchase.${action}`, title: action === 'approve' ? 'Approve This Purchase' : action === 'deny' ? 'Deny This Purchase' : 'Stop This Purchase',
    category: 'payments', scopes: ['write:payments'], access: 'admin', dangerous: true,
    // A window is answered once; a repeat finds it answered and refuses, changing nothing.
    repeat: 'safe',
    // Answering a purchase window is the owner's; stopping a purchase is open to the Agent.
    ...(action === 'cancel' ? {} : { ownerOnly: true }),
    description: action === 'cancel'
      ? 'Stop an admitted checkout using its exact purchaseId and operationId, or object to a live window using purchaseId and windowId. Requires an explicit owner action, confirm: true and current paired admin authority with write:payments. Stopping is a request, not proof that an order was undone; inspect final status and merchant history if submission may have begun. No automatic retry.'
      : `${action === 'approve' ? 'Approve an above-budget purchase or explicitly acknowledge an in-budget purchase' : 'Refuse the pending purchase'} using the exact live purchase and window references. Requires an explicit owner action, confirm: true and current paired admin authority with write:payments. The same inbox also consumes authenticated channel replies. A stale, answered or expired window refuses; this never submits directly or overrides budget, merchant, page or address checks.`,
    http: { method: 'POST', path: `/api/payments/purchase/${action}` },
    inputSchema: action === 'cancel' ? PAYMENTS_PURCHASE_CANCEL_INPUT_SCHEMA : PAYMENTS_PURCHASE_ANSWER_INPUT_SCHEMA,
    outputSchema: action === 'cancel' ? PAYMENTS_PURCHASE_CANCEL_OUTPUT_SCHEMA : PAYMENTS_PURCHASE_ANSWER_OUTPUT_SCHEMA,
  })),
  methodDescriptor({
    id: 'payments.budget.status',
    title: 'Payment Budget Status',
    description:
      "Today's spending pools: the daily item budget, the separate overage budget that covers only unavoidable charges (tax, mandatory fees, and the delivery option actually used), and the tolerance allowance. Each reports its limit, what today has spent, what purchases in flight are holding, and what is left. Includes the calendar day and the timezone it was computed in, the day resets at midnight in daemon.timezone, UTC when unset, and whether this node is the one currently allowed to spend. Each spend keeps the day it was made on, in the zone then in force, and counts until that day is over, so changing the timezone cannot hand back a spent budget.",
    category: 'payments',
    scopes: ['read:payments'],
    http: { method: 'GET', path: '/api/payments/budget' },
    inputSchema: PAYMENTS_BUDGET_STATUS_INPUT_SCHEMA,
    outputSchema: PAYMENTS_BUDGET_STATUS_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'payments.cards.list',
    title: 'List Payment Cards',
    description:
      'Configured cards, as METADATA ONLY: id, label, brand, last four digits, whether it is a virtual or a real card, expiry month and year, and the issuer spend cap the owner declared for a virtual card (declared, unverifiable by us, and never treated as an enforcement layer of ours). materialComplete reports whether every required secret field is present without revealing any of them. The card number, expiry, CVV and cardholder name live in the daemon secret store and there is no method that returns them.',
    category: 'payments',
    scopes: ['read:payments'],
    http: { method: 'GET', path: '/api/payments/cards' },
    inputSchema: PAYMENTS_CARDS_LIST_INPUT_SCHEMA,
    outputSchema: PAYMENTS_CARDS_LIST_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'payments.cards.create',
    repeat: 'unsafe',
    title: 'Add a Payment Card',
    description:
      'Store a card. The number, expiry, CVV and cardholder name go to the daemon secret store, encrypted at rest, under keys derived from the config path; only the label, brand, last four digits, kind and declared issuer cap are kept as config. The response carries the metadata record and never echoes what was submitted, because an echo would be a read path and no read path exists. A virtual card with a hard issuer cap is the recommended configuration: it bounds what any leak could cost to one killable number, which a real card number does not.',
    category: 'payments',
    scopes: ['write:payments'],
    access: 'admin',
    http: { method: 'POST', path: '/api/payments/cards' },
    inputSchema: PAYMENTS_CARDS_CREATE_INPUT_SCHEMA,
    outputSchema: PAYMENTS_CARDS_CREATE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'payments.cards.delete',
    repeat: 'safe',
    irreversible: true,
    title: 'Remove a Payment Card',
    description:
      'Delete a card: its config metadata and every secret derived from its config path, reporting how many secret entries were cleared so a partial deletion is visible rather than silent. payments.defaultCardId is not cleared by a delete; payments.cards.list shows a stale id as empty, and every purchase must name its card anyway.',
    category: 'payments',
    scopes: ['write:payments'],
    access: 'admin',
    http: { method: 'DELETE', path: '/api/payments/cards/{id}' },
    inputSchema: PAYMENTS_CARDS_DELETE_INPUT_SCHEMA,
    outputSchema: PAYMENTS_CARDS_DELETE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'payments.checkout.approve',
    replay: IDEMPOTENCY_KEY_REPLAY,
    title: 'Approve One Purchase',
    description:
      'The owner approves one purchase in advance, out of band from the conversation that will run it: the merchant\'s registrable domain, the item, and the most it may cost. Optional unless payments.confirmEveryPurchase is on. The amount is read in the budget currency ("25" and "25.00" are the same amount) and an amount no purchase could match is refused before anything is recorded. Mints a persisted, single-use approval bound to those fields, expiring in five minutes; a matching payments.checkout.begin spends it, and it answers that purchase\'s approval window for a total up to its amount. Requires confirm: true and the explicit-user-request context, the same confirmation gate every destructive verb on this daemon uses; /payments approve and the web UI send both. The response never carries card material; this verb never touches a card at all.',
    category: 'payments',
    scopes: ['write:payments'],
    access: 'admin',
    http: { method: 'POST', path: '/api/payments/checkout/approve' },
    dangerous: true,
    ownerOnly: true,
    inputSchema: objectSchema({
      confirm: BOOLEAN_SCHEMA,
      merchantDomain: STRING_SCHEMA,
      item: STRING_SCHEMA,
      amount: STRING_SCHEMA,
    }, ['confirm', 'merchantDomain', 'item', 'amount']),
    outputSchema: objectSchema({
      approved: BOOLEAN_SCHEMA,
      action: STRING_SCHEMA,
      merchantDomain: STRING_SCHEMA,
      item: STRING_SCHEMA,
      amount: STRING_SCHEMA,
      expiresAt: STRING_SCHEMA,
    }, ['approved', 'action', 'merchantDomain', 'item', 'amount', 'expiresAt']),
  }),
  methodDescriptor({
    id: 'payments.standing.list',
    title: 'Standing Purchase Authorisations',
    description:
      'The purchases the owner authorised in advance for runs nobody starts in the moment (a schedule or a trigger): for each, its id, the item in his words, the shops it may be bought from, the most one purchase may come to, the most all of them may come to over its period, what is spent or held in the current period and what is left, and when it expires. A scheduled purchase names one of these ids as standingId on payments.checkout.begin.',
    category: 'payments',
    scopes: ['read:payments'],
    http: { method: 'GET', path: '/api/payments/standing' },
    inputSchema: PAYMENTS_STANDING_LIST_INPUT_SCHEMA,
    outputSchema: PAYMENTS_STANDING_LIST_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'payments.standing.create',
    replay: IDEMPOTENCY_KEY_REPLAY,
    title: 'Authorise a Purchase in Advance',
    description:
      'The owner authorises, in advance, a purchase a schedule or trigger may start without asking him: the item in his words, the shops, the most one purchase may come to, the most all of them may come to every periodDays days, and an optional last day. Amounts are read in the budget currency. Every other limit still applies to each purchase: the budgets, the per-purchase ceiling and the veto or approval window. Requires confirm: true and the explicit-user-request context; /payments standing add sends both. The owner\'s own act: an agent cannot add one.',
    category: 'payments',
    scopes: ['write:payments'],
    access: 'admin',
    dangerous: true,
    ownerOnly: true,
    http: { method: 'POST', path: '/api/payments/standing' },
    inputSchema: PAYMENTS_STANDING_CREATE_INPUT_SCHEMA,
    outputSchema: PAYMENTS_STANDING_CREATE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'payments.standing.delete',
    repeat: 'safe',
    title: 'Withdraw a Standing Authorisation',
    description:
      'Remove one standing purchase authorisation by its id. No new purchase can start under it, and one under it that a daemon restart interrupted is not resumed; a purchase already running keeps its window, where the owner can still stop it. Requires confirm: true and the explicit-user-request context; /payments standing remove sends both. The owner\'s own act.',
    category: 'payments',
    scopes: ['write:payments'],
    access: 'admin',
    dangerous: true,
    ownerOnly: true,
    http: { method: 'POST', path: '/api/payments/standing/delete' },
    inputSchema: PAYMENTS_STANDING_DELETE_INPUT_SCHEMA,
    outputSchema: PAYMENTS_STANDING_DELETE_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'payments.checkout.begin',
    replay: { in: 'body', name: 'requestId', behavior: 'Reusing an admitted `requestId` never starts another purchase, even with changed input; after a lost response read the outcome with payments.purchase.status and that requestId.' },
    title: 'Buy What Is In This Checkout',
    description:
      "Admit one checkout against an open browser page and return a durable accepted acknowledgement before its approval/veto wait. Supply a stable requestId saved before sending; after a lost response, query payments.purchase.status with that ID. Reusing an admitted ID never starts another execution, even with changed input. Inside the owner's limits no prior approval is needed; with payments.confirmEveryPurchase on, a begin must state requestedMax and spend a matching payments.checkout.approve. cardId may be omitted to pay with payments.defaultCardId, and merchantDiscovered is read as sent. A purchase the owner asked for now carries the explicit-user-request context; one a schedule or trigger starts names standingId (payments.standing.list) instead and is bound to that entry's item, shops and maximums. The daemon parses amounts, checks cart/merchant/taint/recurrence and budget, runs the shipping ladder and owner window, fills stored addresses/card and submits once. Accepted does not mean purchased. Status retains processing, refusal, cancellation, verification and uncertain-submission outcomes. Disconnecting the caller does not cancel the operation; stopping or shutdown drains its actual work. An uncertain merchant submission is never retried automatically.",
    category: 'payments',
    scopes: ['write:payments'],
    access: 'admin',
    http: { method: 'POST', path: '/api/payments/checkout/begin' },
    inputSchema: PAYMENTS_CHECKOUT_BEGIN_INPUT_SCHEMA,
    outputSchema: PAYMENTS_CHECKOUT_BEGIN_OUTPUT_SCHEMA,
  }),
  methodDescriptor({
    id: 'payments.purchases.list',
    title: 'List Purchases',
    description:
      'The purchase audit ledger: what was bought, from which merchant registrable domain, how much (item, tax, fees and delivery separately), which budget pool each part drew on, which delivery tier was requested and which was actually used, whether the shipping ladder stepped it down, which window ran and how it ended, which command-authority channel answered, and the outcome. Reconcilable against a card statement. Never contains a card number, expiry or CVV. When the shop mails that a purchase was refunded, the time is recorded as `refundedAt` on that purchase and the owner is told; check the card statement for the credit. A refund credits no pool: a refund on day five refilling day five would be permission to buy again that nobody granted.',
    category: 'payments',
    scopes: ['read:payments'],
    http: { method: 'GET', path: '/api/payments/purchases' },
    inputSchema: PAYMENTS_PURCHASES_LIST_INPUT_SCHEMA,
    outputSchema: PAYMENTS_PURCHASES_LIST_OUTPUT_SCHEMA,
  }),
];
