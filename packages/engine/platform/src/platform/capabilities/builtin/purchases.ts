/**
 * Waiting for you, Purchases: the purchases that wait on the owner, in one
 * list, and what he can do on each.
 *
 * Home `daemon`: the payment host is the daemon's (its purchase windows, the
 * checkouts it runs, the security codes it waits for), so every capability
 * here runs there, through the daemon method that already does the act
 * (`payments.purchase.*`), called as the same caller: the method keeps its own
 * paired-owner authority, its confirmation and its refusals.
 *
 * What waits, one row per purchase:
 *  - a purchase window (approve or deny one over budget; let one inside the
 *    budget go ahead or stop it): the owner inbox's `purchase` item, answered
 *    with `questions.answer` on its own keys, which holds the answer to the
 *    authority `payments.purchase.approve` takes;
 *  - an approved purchase waiting for its card security code
 *    (`payments.cvvHandling: prompt`): `payments.security-code`, the code typed
 *    on a hidden line, handed to that purchase in memory and kept nowhere;
 *  - a checkout running (`payments.stop-checkout`) or one whose submission is
 *    uncertain (`payments.finding`, after the owner looked at the merchant's
 *    order history);
 *  - a purchase whose status record could not be read, named so its evidence
 *    is inspected.
 *
 * A window inside the budget goes ahead when its time runs out, even when its
 * notice never reached the owner (the owner's standing ruling, payments/windows.ts).
 * No card number, security code or page reading is ever in an answer, a
 * refusal or a log.
 */
import { listEveryOwnerItem, type OwnerItem } from '../../control-plane/owner-inbox.js';
import { formatMinorUnits, readPurchaseNoticeRow } from '../../payments/message.js';
import { canReconcilePaymentOperation, isLivePaymentOperation, paymentOperationDescription, type PaymentOperationView } from '../../payments/operation-view.js';
import { PURCHASE_AMOUNT_METADATA, PURCHASE_DEADLINE_METADATA, PURCHASE_ITEM_METADATA, PURCHASE_SHOP_METADATA } from '../../payments/payment-ports.js';
import { parseCurrencyCode } from '../../payments/types.js';
import { readPaymentWindowStatus, type PaymentPurchaseStatus, type PaymentSecurityCodeRequestView } from '../../payments/window-view.js';
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type InputDescription } from '../types.js';
import type { WaitingCapabilityServices } from './waiting.js';

const PLACE = 'Waiting for you, under Purchases';
const OWNERS = 'answering a purchase is the owner\'s own act';

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}

/** Text from another process, with control characters taken out. */
function text(value: unknown): string {
  return String(value ?? '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

function when(ms: number): string {
  return new Date(ms).toLocaleString();
}

/** The daemon method as this same caller; only the daemon's `capabilities.run` gives one. */
function methodOf(caller: CapabilityCaller, what: string): (methodId: string, body: Record<string, unknown>) => Promise<unknown> {
  if (!caller.method) throw new CapabilityRefusal(`${what} was not done: it runs in the daemon, and this caller reached no daemon.`);
  return caller.method;
}

/** What a purchase is, in one phrase ("USB-C cable from shop.example, $12.99"), from its notice or its window's facts. */
function purchasePhrase(notice: string | undefined, facts?: { readonly item?: string | undefined; readonly shop?: string | undefined; readonly amount?: string | undefined }): string | undefined {
  const row = notice === undefined ? undefined : readPurchaseNoticeRow(text(notice));
  if (row) return `${row.item} from ${row.merchant}, ${row.total}`;
  if (facts?.item && facts.amount) return `${facts.item}${facts.shop ? ` from ${facts.shop}` : ''}, ${facts.amount}`;
  return undefined;
}

function amountOf(operation: PaymentOperationView): string | undefined {
  const code = operation.currency === null ? null : parseCurrencyCode(operation.currency);
  if (operation.totalMinorUnits === null || !code) return undefined;
  try { return formatMinorUnits(operation.totalMinorUnits as never, code); } catch { return undefined; }
}

/** One purchase as the list shows it. `state` is what the place's controls attach to. */
export interface WaitingPurchase {
  readonly id: string;
  readonly state: 'window' | 'code' | 'running' | 'stopping' | 'check' | 'unreadable';
  readonly title: string;
  /** The purchase itself in words ("a packet of basil seeds from seedhaus.test, $8.85"): a form or a question names it so, not by its row's title. */
  readonly what?: string | undefined;
  readonly purchaseId: string;
  /** The owner-inbox item the payment host posted for a window (every surface shows it). */
  readonly itemId?: string | undefined;
  /** The window open on the payment host: answered by `payments.answer-window`. Absent while only the inbox holds it. */
  readonly windowId?: string | undefined;
  readonly operationId?: string | undefined;
  readonly windowKind?: 'approval' | 'veto' | undefined;
  readonly deadlineMs?: number | undefined;
  readonly merchant?: string | undefined;
  readonly cardLast4?: string | undefined;
  readonly where: string;
  readonly notice?: string | undefined;
}

const metadataText = (item: OwnerItem, key: string): string | undefined => {
  const value = item.metadata?.[key];
  return typeof value === 'string' && value ? text(value) : undefined;
};

/** Reads the inbox's open purchase windows and the payment host's status; a status that could not be read is said. */
async function waitingPurchases(services: WaitingCapabilityServices, caller: CapabilityCaller): Promise<{ readonly rows: readonly WaitingPurchase[]; readonly unreadable?: string | undefined; readonly stopped?: string | undefined }> {
  const windows = services.ownerInbox ? await listEveryOwnerItem(services.ownerInbox, { status: 'open', kinds: ['purchase'] }) : [];
  let status: PaymentPurchaseStatus | undefined;
  let unreadable: string | undefined;
  try {
    status = readPaymentWindowStatus(await methodOf(caller, 'Reading the purchases that wait')('payments.purchase.status', {}));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Payments not switched on: nothing can wait, and nothing is unread.
    if (!/unavailable on this payment host|METHOD_NOT_FOUND|no handler/i.test(message)) unreadable = text(message);
  }
  const rows: WaitingPurchase[] = [];
  const seen = new Set<string>();
  const codes = new Map<string, PaymentSecurityCodeRequestView>((status?.securityCodes ?? []).map((request) => [request.purchaseId, request]));
  // A purchase is named by what it buys after its window has closed too: the facts its window's inbox item kept
  // (answered or not), never its id.
  const posted = services.ownerInbox && (codes.size > 0 || (status?.operations.length ?? 0) > 0)
    ? await listEveryOwnerItem(services.ownerInbox, { status: 'all', kinds: ['purchase'] }).catch(() => [] as readonly OwnerItem[]) : [];
  const factsOf = (purchaseId: string): { item?: string | undefined; shop?: string | undefined; amount?: string | undefined } | undefined => {
    const item = posted.find((entry) => metadataText(entry, 'purchaseId') === purchaseId && metadataText(entry, PURCHASE_ITEM_METADATA) !== undefined);
    return item ? { item: metadataText(item, PURCHASE_ITEM_METADATA), shop: metadataText(item, PURCHASE_SHOP_METADATA), amount: metadataText(item, PURCHASE_AMOUNT_METADATA) } : undefined;
  };
  const noticeOf = (purchaseId: string): string | undefined => status?.windows.find((window) => window.purchaseId === purchaseId)?.notice;
  for (const request of codes.values()) {
    seen.add(request.purchaseId);
    const what = purchasePhrase(noticeOf(request.purchaseId), factsOf(request.purchaseId)) ?? `a purchase from ${text(request.merchantDomain)}`;
    rows.push({
      id: `code:${request.purchaseId}`, state: 'code', title: `Security code needed: ${what}`, what, purchaseId: request.purchaseId, windowId: request.windowId,
      deadlineMs: request.deadlineMs, merchant: text(request.merchantDomain), cardLast4: text(request.cardLast4),
      where: `Approved; it waits for the security code of the card ending ${text(request.cardLast4)} until ${when(request.deadlineMs)}, and nothing is bought without it.`,
    });
  }
  // A window open on the payment host is the one answered; its inbox item (the same window, posted for every surface)
  // gives the purchase's facts. A window only the inbox holds (the host still recovering) is listed, not answerable here.
  const itemOf = (purchaseId: string): OwnerItem | undefined => windows.find((item) => metadataText(item, 'purchaseId') === purchaseId && !item.options.includes('ok'));
  const windowRow = (purchaseId: string, kind: 'approval' | 'veto', deadline: number | undefined, notice: string, windowId: string | undefined, item: OwnerItem | undefined): WaitingPurchase => {
    const what = purchasePhrase(notice, item ? { item: metadataText(item, PURCHASE_ITEM_METADATA), shop: metadataText(item, PURCHASE_SHOP_METADATA), amount: metadataText(item, PURCHASE_AMOUNT_METADATA) } : undefined)
      ?? (item ? text(item.presentation?.title || item.title) : `purchase ${text(purchaseId)}`);
    return {
      id: `window:${purchaseId}`, state: 'window', title: kind === 'veto' ? `Goes ahead unless you stop it: ${what}` : `Waits for your yes: ${what}`, what,
      purchaseId, ...(item ? { itemId: item.id } : {}), ...(windowId ? { windowId } : {}), windowKind: kind, ...(deadline !== undefined ? { deadlineMs: deadline } : {}),
      where: kind === 'veto'
        ? `Inside your limits: it goes ahead${deadline !== undefined ? ` at ${when(deadline)}` : ' when its time runs out'} unless you stop it, even if its notice never reached you.`
        : `Over what you allow without asking: it waits for your yes${deadline !== undefined ? ` until ${when(deadline)}` : ''}, and nothing is bought without it.`,
      notice: text(notice),
    };
  };
  for (const window of status?.windows ?? []) {
    if (seen.has(window.purchaseId)) continue;
    seen.add(window.purchaseId);
    rows.push(windowRow(window.purchaseId, window.kind, window.deadlineMs, window.notice, window.windowId, itemOf(window.purchaseId)));
  }
  for (const item of windows) {
    const purchaseId = metadataText(item, 'purchaseId') ?? item.id;
    if (item.options.length === 0 || item.options.includes('ok') || seen.has(purchaseId)) continue;
    seen.add(purchaseId);
    const posted = item.metadata?.[PURCHASE_DEADLINE_METADATA];
    rows.push(windowRow(purchaseId, item.options.includes('go') ? 'veto' : 'approval', typeof posted === 'number' ? posted : item.expiresAt, item.detail, undefined, item));
  }
  for (const operation of status?.operations ?? []) {
    if (seen.has(operation.purchaseId)) continue;
    const live = isLivePaymentOperation(operation.state);
    const check = canReconcilePaymentOperation(operation);
    if (!live && !check) continue;
    seen.add(operation.purchaseId);
    const amount = amountOf(operation);
    const what = purchasePhrase(noticeOf(operation.purchaseId), factsOf(operation.purchaseId)) ?? `purchase ${text(operation.purchaseId)}${amount ? `, ${amount}` : ''}`;
    rows.push({
      id: `operation:${operation.operationId}`, state: check ? 'check' : operation.state === 'cancelling' ? 'stopping' : 'running',
      title: check ? `Check with the shop: ${what}` : operation.state === 'cancelling' ? `Stopping: ${what}` : `Checkout running: ${what}`, what,
      purchaseId: operation.purchaseId, operationId: operation.operationId, where: text(paymentOperationDescription(operation)),
    });
  }
  for (const row of status?.unreadable ?? []) {
    if (seen.has(row.purchaseId)) continue;
    rows.push({ id: `unreadable:${row.purchaseId}`, state: 'unreadable', title: `Its record could not be read: purchase ${text(row.purchaseId)}`, purchaseId: row.purchaseId, where: text(row.reason) });
  }
  return { rows, ...(unreadable ? { unreadable } : {}), ...(status?.stopped ? { stopped: text(status.stopped.message) } : {}) };
}

export const PAYMENTS_PENDING: CapabilityDefinition<WaitingCapabilityServices> = {
  capability: { id: 'payments.pending', group: 'waiting', home: 'daemon', repeat: 'safe' },
  actionId: 'see-waiting', label: 'See the purchases waiting for you', word: 'pending', inputs: [],
  sentence: 'Lists every purchase that waits on you: one to approve or let go ahead, one waiting for a card security code, a checkout you can still stop, and one to check with the shop.',
  done: '', touches: 'reads', lasts: 'not-a-change', risk: 'none', effects: ['payments.read'], example: {},
  async run(_values, services, caller) {
    const { rows, unreadable, stopped } = await waitingPurchases(services, caller);
    const data = { purchases: rows, ...(unreadable ? { unreadable } : {}), ...(stopped ? { stopped } : {}) };
    const lines = rows.length === 0
      ? [unreadable ? `The purchases could not be read: ${unreadable}` : 'No purchase is waiting for you.']
      : [`Purchases waiting for you (${rows.length}):`, ...rows.map((row) => `  ${row.title}. ${row.where}`)];
    if (rows.length > 0 && unreadable) lines.push(`The payment host's status could not be read, so a checkout may be missing here: ${unreadable}`);
    if (stopped) lines.push(stopped);
    return { text: lines.join('\n'), data };
  },
};

const PURCHASE: InputDescription = {
  id: 'purchase', label: 'Purchase', help: 'The purchase, as the list names it', kind: 'text', freeTextReason: 'the id of a purchase shown in the list',
  required: true, typed: { position: 1 },
};

/** The row the person acted on, read again now: what waits may have moved since it was shown. */
async function current(services: WaitingCapabilityServices, caller: CapabilityCaller, id: string, state: readonly WaitingPurchase['state'][], what: string): Promise<WaitingPurchase> {
  const wanted = id.trim();
  const { rows, unreadable } = await waitingPurchases(services, caller);
  const row = rows.find((candidate) => candidate.id === wanted || candidate.purchaseId === wanted || candidate.operationId === wanted);
  if (!row) {
    throw new CapabilityRefusal(unreadable ? `${what} was not done: the purchases could not be read (${unreadable}).` : `${what} was not done: no purchase waiting for you is ${text(wanted)}; it may have ended meanwhile.`,
      `${PLACE} shows what waits now.`, 'NOT_FOUND');
  }
  if (!state.includes(row.state)) throw new CapabilityRefusal(`${what} was not done: "${row.title}" no longer takes it. ${row.where}`, undefined, 'NOT_OPEN');
  return row;
}

const WINDOW_ANSWERS = {
  approve: { method: 'payments.purchase.approve', kind: 'approval', said: 'Approved: the purchase goes ahead now.', answer: 'approve' },
  deny: { method: 'payments.purchase.deny', kind: 'approval', said: 'Refused: nothing is bought.', answer: 'deny' },
  go: { method: 'payments.purchase.approve', kind: 'veto', said: 'It goes ahead now.', answer: 'acknowledge' },
  stop: { method: 'payments.purchase.cancel', kind: 'veto', said: 'Stopped: nothing is bought.', answer: 'object' },
} as const;

export const PAYMENTS_ANSWER_WINDOW: CapabilityDefinition<WaitingCapabilityServices> = {
  capability: { id: 'payments.answer-window', group: 'waiting', home: 'daemon', repeat: 'safe' },
  actionId: 'answer-window', label: 'Answer a purchase that waits for you', word: 'answer-window',
  inputs: [PURCHASE, {
    id: 'answer', label: 'Your answer', help: 'Over budget: buy it or not; inside your limits: let it go ahead or stop it', kind: 'choice',
    choices: [
      { value: 'approve', label: 'Yes, buy it', help: 'A purchase over what you allow without asking.', risk: 'spends-money', riskDone: 'It goes ahead with your card; the list shows how it ends.' },
      { value: 'deny', label: 'No', help: 'Nothing is bought.' },
      { value: 'go', label: 'Let it go ahead', help: 'A purchase inside your limits, now instead of at its time.', risk: 'spends-money', riskDone: 'It goes ahead with your card; the list shows how it ends.' },
      { value: 'stop', label: 'Stop it', help: 'Nothing is bought.' },
    ],
    required: true, typed: { position: 2 },
  }],
  sentence: '{purchase} is answered "{answer}": a yes buys it now, a no or a stop buys nothing.',
  done: '', touches: 'another-machine', lasts: 'kept', risk: 'none', effects: ['purchase.approve'],
  ownerOnly: { reason: OWNERS, instead: `Ask the owner to answer it in ${PLACE}.` },
  example: { purchase: 'window:purchase-1', answer: 'stop' },
  async run(values, services, caller) {
    const chosen = WINDOW_ANSWERS[values.answer as keyof typeof WINDOW_ANSWERS];
    if (!chosen) throw new CapabilityRefusal('An answer is one of: approve, deny (over budget), go, stop (inside your limits). Nothing was answered.', undefined, 'INVALID_ARGUMENT');
    const row = await current(services, caller, values.purchase ?? '', ['window'], 'Answering the purchase');
    if (row.windowKind !== chosen.kind) {
      throw new CapabilityRefusal(row.windowKind === 'veto'
        ? 'This purchase is inside your limits: answer go (let it go ahead) or stop. Nothing was answered.'
        : 'This purchase is over budget: answer approve (buy it) or deny. Nothing was answered.', undefined, 'INVALID_ARGUMENT');
    }
    const method = methodOf(caller, 'Answering the purchase');
    if (!row.windowId) {
      // Only the inbox holds the window now (the payment host is starting again): the answer is recorded on its item, which
      // the window reads when it resumes (an answer recorded by its deadline is never taken for silence). Held to the
      // same authority as on the host.
      if (!row.itemId) throw new CapabilityRefusal('Answering the purchase was not done: its window is open nowhere now; it goes as its notice says.', undefined, 'NOT_OPEN');
      const outcome = record(await method('inbox.answer', { itemId: row.itemId, option: values.answer }));
      if (outcome.applied !== true) throw new CapabilityRefusal(`Not answered: ${text(record(outcome.refusal).reason) || 'the inbox did not record the answer'}.`, undefined, 'NOT_APPLIED');
      return { text: chosen.said, data: { purchaseId: row.purchaseId, answer: values.answer } };
    }
    // Held to the payment host's own check: the owner's own machine or a paired device, admin, with write:payments.
    const answer = record(await method(chosen.method, { purchaseId: row.purchaseId, windowId: row.windowId, confirm: true }));
    if (answer.purchaseId !== row.purchaseId || answer.answer !== chosen.answer) throw new CapabilityRefusal('The payment host did not confirm the answer; read the list again before answering once more.', undefined, 'NOT_APPLIED');
    return { text: chosen.said, data: { purchaseId: row.purchaseId, answer: values.answer } };
  },
};

export const PAYMENTS_STOP_CHECKOUT: CapabilityDefinition<WaitingCapabilityServices> = {
  capability: { id: 'payments.stop-checkout', group: 'waiting', home: 'daemon', repeat: 'safe' },
  actionId: 'stop-checkout', label: 'Stop a checkout that is running', word: 'stop-checkout', inputs: [PURCHASE],
  sentence: 'The checkout of {purchase} is asked to stop before anything is sent to the shop; if the order was already being submitted, stopping does not undo it.',
  done: '', touches: 'another-machine', lasts: 'kept', risk: 'none', tightens: true, effects: ['payments.administer'],
  example: { purchase: 'operation:op-1' },
  async run(values, services, caller) {
    const row = await current(services, caller, values.purchase ?? '', ['running'], 'Stopping the checkout');
    const answer = record(await methodOf(caller, 'Stopping the checkout')('payments.purchase.cancel', { purchaseId: row.purchaseId, operationId: row.operationId, confirm: true }));
    if (answer.accepted !== true) throw new CapabilityRefusal('The payment host did not confirm the stop; read the list again before trying once more.', undefined, 'NOT_APPLIED');
    return {
      text: answer.mayHaveSubmitted === true
        ? 'Stop asked for; the order may already have gone to the shop, so check the shop\'s order history. Stopping does not undo an order.'
        : 'Stop asked for before anything went to the shop. The list shows when it has stopped.',
      data: { purchaseId: row.purchaseId, operationId: row.operationId, mayHaveSubmitted: answer.mayHaveSubmitted === true },
    };
  },
};

export const PAYMENTS_FINDING: CapabilityDefinition<WaitingCapabilityServices> = {
  capability: { id: 'payments.finding', group: 'waiting', home: 'daemon', repeat: 'safe' },
  actionId: 'finding', label: 'Record what the shop\'s order history shows', word: 'finding',
  inputs: [PURCHASE, {
    id: 'finding', label: 'The shop\'s order history shows', help: 'Look at the shop\'s order history and your card statement for this checkout first', kind: 'choice',
    // Yes or no to "an order was placed": the sentence below reads the same with the value as with its label.
    choices: [
      { value: 'yes', label: 'An order was placed', help: 'The original payment accounting is settled; nothing new is ordered.' },
      { value: 'no', label: 'No order was placed', help: 'The unspent hold is released; spending already committed is not credited.' },
    ],
    required: true, typed: { position: 2 },
  }],
  sentence: 'Having looked at the shop\'s order history for {purchase}, you record whether it shows an order was placed: {finding}; the purchase\'s bookkeeping is settled by it and nothing new is ordered.',
  done: '', touches: 'another-machine', lasts: 'kept', risk: 'cannot-be-undone', effects: ['purchase.approve'],
  ownerOnly: { reason: 'what the shop\'s order history shows is the owner\'s finding', instead: `Ask the owner to record it in ${PLACE}.` },
  example: { purchase: 'operation:op-1', finding: 'no' },
  async run(values, services, caller) {
    const finding = values.finding === 'yes' ? 'purchased' : values.finding === 'no' ? 'not-purchased' : '';
    if (!finding) throw new CapabilityRefusal('Say what the shop\'s order history shows: an order was placed, or no order was placed. Nothing was recorded.', undefined, 'INVALID_ARGUMENT');
    const row = await current(services, caller, values.purchase ?? '', ['check'], 'Recording the finding');
    const answer = record(await methodOf(caller, 'Recording the finding')('payments.purchase.reconcile', {
      purchaseId: row.purchaseId, operationId: row.operationId, outcome: finding, inspectedMerchantHistory: true, confirm: true,
    }));
    if (answer.purchaseId !== row.purchaseId) throw new CapabilityRefusal('The payment host did not confirm the finding; read the list again, and if it shows your finding saved, record the same one again. Do not place another order.', undefined, 'NOT_APPLIED');
    return { text: finding === 'purchased' ? 'Recorded: an order was placed. Its bookkeeping is settled; nothing new was ordered.' : 'Recorded: no order was placed. The unspent hold was released; nothing new was ordered.', data: { purchaseId: row.purchaseId, finding } };
  },
};

export const PAYMENTS_SECURITY_CODE: CapabilityDefinition<WaitingCapabilityServices> = {
  capability: { id: 'payments.security-code', group: 'waiting', home: 'daemon', repeat: 'safe' },
  actionId: 'security-code', label: 'Give a card\'s security code to a purchase waiting for it', word: 'security-code',
  inputs: [PURCHASE, {
    id: 'code', label: 'Security code', help: 'The three or four digits on the back of the card; hidden as you type, kept nowhere', kind: 'secret', required: true, typed: { position: 2 },
  }],
  sentence: 'The security code you type is handed to {purchase}, which is approved and waits for it; it is used for this purchase\'s card entry and kept nowhere.',
  done: '', touches: 'another-machine', lasts: 'not-a-change', risk: 'none', effects: ['card.enter'],
  ownerOnly: { reason: OWNERS, instead: `Ask the owner to type the code in ${PLACE}.` },
  example: { purchase: 'code:purchase-1' },
  async run(values, services, caller) {
    const row = await current(services, caller, values.purchase ?? '', ['code'], 'Giving the security code');
    // The code goes only into the request: never into an answer, a refusal or a log.
    const answer = record(await methodOf(caller, 'Giving the security code')('payments.purchase.securityCode', {
      purchaseId: row.purchaseId, windowId: row.windowId, code: (values.code ?? '').trim(), confirm: true,
    }));
    if (answer.accepted !== true) throw new CapabilityRefusal('The purchase did not confirm it took the code; if it still waits for one, type the code again.', undefined, 'NOT_APPLIED');
    return { text: 'The purchase took the code and carries on; the list shows how it ends.', data: { purchaseId: row.purchaseId } };
  },
};

export const PURCHASES_CAPABILITIES: readonly CapabilityDefinition<WaitingCapabilityServices>[] = [PAYMENTS_PENDING, PAYMENTS_ANSWER_WINDOW, PAYMENTS_STOP_CHECKOUT, PAYMENTS_FINDING, PAYMENTS_SECURITY_CODE];
