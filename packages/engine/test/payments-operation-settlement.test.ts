import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../platform/src/platform/daemon/control-plane.js';
import { PairingTokenManager } from '../platform/src/platform/pairing/pairing-token-store.js';
import { BudgetLedger } from '../platform/src/platform/payments/budget.js';
import { CardMaterialRedactor } from '../platform/src/platform/payments/card-redaction.js';
import { CheckoutSubmitRefused, type CheckoutChallenge } from '../platform/src/platform/payments/checkout-page.js';
import type { CheckoutJournal, InFlightCheckout } from '../platform/src/platform/payments/checkout-registry.js';
import { DurableCheckoutJournal } from '../platform/src/platform/payments/host/checkout-journal-store.js';
import { DurablePaymentOperations } from '../platform/src/platform/payments/host/operation-store.js';
import { CheckoutOperations } from '../platform/src/platform/payments/host/checkout-operations.js';
import { CheckoutOwnershipError } from '../platform/src/platform/payments/checkout-ownership.js';
import { retainResumedCheckoutHold } from '../platform/src/platform/payments/resumed-hold.js';
import { ProtectedPaymentRequests } from '../platform/src/platform/payments/host/protected-requests.js';
import { DaemonApprovalStore } from '../platform/src/platform/payments/host/approval-store.js';
import { DaemonCardStore } from '../platform/src/platform/payments/host/card-store.js';
import { DaemonPurchaseLedger } from '../platform/src/platform/payments/host/purchase-ledger.js';
import { configBackedAddressStore } from '../platform/src/platform/payments/host/address-store.js';
import { channelBackedPaymentNotifier } from '../platform/src/platform/payments/host/notifier.js';
import { registerPaymentsMethods } from '../platform/src/platform/payments/host/register.js';
import { createJevMerchantJudge } from '../platform/src/platform/payments/merchant-judge-model.js';
import { PaymentReplyInbox } from '../platform/src/platform/payments/reply-inbox.js';
import { readPaymentWindowStatus } from '../platform/src/platform/payments/browser.js';
import { paymentOperationDescription, type PaymentOperationView } from '../platform/src/platform/payments/operation-view.js';
import { getProcessUntrustedContentLedger, resetProcessUntrustedContentLedgerForTests } from '../platform/src/platform/security/untrusted-content.js';
import { configureDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { usePaymentsReadings } from './helpers/payments-readings.ts';

usePaymentsReadings();
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); resetProcessUntrustedContentLedgerForTests(); });

async function until(check: () => boolean | Promise<boolean>, what: string) {
  const deadline = Date.now() + 3000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`The payment fixture never reached: ${what}`);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

type Submit = () => Promise<{ readonly url: string; readonly orderId: string | null; readonly challenge?: CheckoutChallenge | null; readonly verified: boolean }>;

/** The real paired daemon registration over durable stores, with a scripted
 * browser page that answers every check and does what each test says on submit. */
async function harness() {
  resetProcessUntrustedContentLedgerForTests();
  cleanups.push(configureDecisionModelPolicy(() => 'Default - On'));
  const root = makeProjectTempDir('payment-operation-settlement'), catalog = new GatewayMethodCatalog();
  const pairing = new PairingTokenManager(join(root, 'pairing.json')), paired = pairing.mint({ name: 'Synthetic payment owner' });
  const helper = new DaemonControlPlaneHelper({ gatewayMethods: catalog, pairingTokens: pairing, authToken: () => 'synthetic-shared',
    userAuth: { validateSession: () => null } } as unknown as DaemonControlPlaneContext);
  const values: Record<string, unknown> = { 'payments.enabled': true, 'payments.budget.dailyItem': 100,
    'payments.budget.dailyOverage': 100, 'payments.budget.perPurchaseCeiling': 100, 'payments.notifyChannels': 'tui', 'payments.cvvHandling': 'stored' };
  for (const [key, value] of Object.entries({ name: 'Fixture owner', line1: '1 Fixture Street', city: 'Fixture City', region: 'TS', postalCode: '00000', country: 'US' })) values[`payments.shippingAddress.${key}`] = value;
  const config = { get: (key: string) => values[key] }, secrets = new Map<string, string>();
  const cards = new DaemonCardStore({ filePath: join(root, 'cards.json'), cvvHandling: () => 'stored', secrets: {
    async get(key) { return secrets.get(key) ?? null; }, async set(key, value) { secrets.set(key, value); }, async delete(key) { secrets.delete(key); },
  } });
  const card = await cards.create({ label: 'Synthetic test card', kind: 'virtual', number: '4111111111111111', expiryMonth: 1, expiryYear: 2030,
    cvv: '123', cardholderName: 'Fixture owner', issuerCapMinorUnits: null });
  const budget = new BudgetLedger(), effects: string[] = [];
  const page = {
    submit: (async () => ({ url: 'https://www.bestbuy.com/done', orderId: null, verified: false })) as Submit,
    fillFails: false,
    /** Runs inside the durable journal write of the given phase, before it returns. */
    duringPut: undefined as ((record: InFlightCheckout) => Promise<void>) | undefined,
    /** Runs when the window checkpoint's durable write is about to start. */
    beforeCheckpointSave: undefined as (() => void) | undefined,
    /** Settles once a window checkpoint has been durably written. */
    checkpointSaved: Promise.withResolvers<void>(),
    /** Settles once a test's stop has been requested. */
    stopRequested: Promise.withResolvers<void>(),
  };
  class Requests extends ProtectedPaymentRequests {
    override async checkpointWindow(...args: Parameters<NonNullable<ProtectedPaymentRequests['checkpointWindow']>>) {
      page.beforeCheckpointSave?.();
      await super.checkpointWindow(...args);
      page.checkpointSaved.resolve();
    }
  }
  const durable = new DurableCheckoutJournal(join(root, 'journal.json'));
  const journal: CheckoutJournal = {
    async put(record) { await durable.put(record); await page.duringPut?.(record); },
    remove: id => durable.remove(id), list: () => durable.list(),
  };
  const seam = { cardFieldGuard: new CardMaterialRedactor(), armSubmitApproval: async () => {},
    async captureCheckoutRecovery(_sessionId: string, _pageId: string, _refs: readonly string[], owner: { readonly assertCurrent?: (() => void) | undefined }) {
      owner.assertCurrent?.();
      return { connection: { version: 1 as const, endpoint: 'ws://127.0.0.1:9222/devtools/browser/fixture', targetId: 'fixture-tab', browserContextId: 'fixture-context',
        frames: [{ id: 'fixture-frame', loaderId: 'fixture-document', parentId: null }] },
      controls: { version: 1 as const, snapshotId: 'fixture-snapshot', url: 'https://www.bestbuy.com/checkout', controls: [
        { ref: 'card', tag: 'input', role: 'textbox', name: 'Card number', selector: '#card', depth: 1, submits: false, frameChain: [], cardField: true,
          metadata: { name: 'Card number', documentUrl: 'https://www.bestbuy.com/checkout' } },
        { ref: 'submit', tag: 'button', role: 'button', name: 'Place order', selector: '#order', depth: 1, submits: true, frameChain: [],
          metadata: { name: 'Place order', documentUrl: 'https://www.bestbuy.com/checkout' } }] } };
    },
    driverFor: () => ({
      identity: () => ({ sessionId: 'session', pageId: 'page' }), async url() { return 'https://www.bestbuy.com/checkout'; },
      async verifyTerms() { return true; },
      async fill() { effects.push('fill'); }, async choose() { effects.push('choose'); },
      async fillSecrets(entries: readonly { readonly target: string }[]) {
        effects.push('card');
        return page.fillFails ? { filledTargets: [], failedTarget: entries[0]?.target ?? null } : { filledTargets: entries.map(entry => entry.target), failedTarget: null };
      },
      async submitOrder() { effects.push('submit'); return page.submit(); },
    }) };
  const compose = (restore?: Pick<NonNullable<Parameters<typeof registerPaymentsMethods>[1]['checkout']>, 'restoreWindow' | 'retireContinuation'>) => {
    const replies = new PaymentReplyInbox(), operations = new DurablePaymentOperations(join(root, 'operations'));
    const registration = registerPaymentsMethods(catalog, { cards, config, budget, isPaymentsLeader: () => true,
      purchases: new DaemonPurchaseLedger({ filePath: join(root, 'purchases.json') }), checkout: {
        operations, requests: new Requests(join(root, 'requests')), replies, journal,
        approvals: new DaemonApprovalStore(join(root, 'approvals.json')), addresses: configBackedAddressStore(config),
        untrusted: getProcessUntrustedContentLedger(), merchantJudge: createJevMerchantJudge(),
        notifier: channelBackedPaymentNotifier(config, { async deliver() { throw new Error('Payment receipt required'); },
          async deliverWithReceipt(request) { request.assertCurrent?.(); return { receipt: { surfaceKind: 'tui', conversationId: 'fixture-terminal', messageId: '51' } }; } }, replies),
        seam: () => seam, ...restore,
      } });
    const close = async () => { await Promise.all([registration.close(), replies.close()]); };
    cleanups.push(close);
    return { registration, replies, operations, close };
  };
  const call = (methodId: string, body: Record<string, unknown> = {}) => helper.invokeGatewayMethodCall({ methodId, body, authToken: paired.token,
    context: { ...helper.describeAuthenticatedPrincipal(paired.token), explicitUserRequest: true } });
  const identity = { merchantDomain: 'bestbuy.com', item: 'Fixture item' };
  let sequence = 0;
  const begin = async () => {
    expect((await call('payments.checkout.approve', { ...identity, amount: '20.00', confirm: true })).status).toBe(200);
    const body = { ...identity, requestId: `owner-request-${++sequence}`, requestedMax: '20.00', sessionId: 'session', pageId: 'page',
      checkoutUrl: 'https://www.bestbuy.com/checkout', cardId: card.id, requestedLines: [{ label: 'Fixture item', quantity: 1 }],
      lines: [{ label: 'Fixture item', quantity: '1', unitPrice: '$10.00' }], shippingOptions: [{ label: 'Standard', cost: '$0.00' }],
      cardFields: [{ field: 'number', ref: 'card' }], placeOrderTarget: 'submit' };
    const accepted = await call('payments.checkout.begin', body);
    expect(accepted.status).toBe(200);
    return body.requestId;
  };
  const status = async (purchaseId: string): Promise<PaymentOperationView | undefined> =>
    readPaymentWindowStatus((await call('payments.purchase.status', { purchaseId })).body).operations[0];
  const settled = async (purchaseId: string, state: PaymentOperationView['state']) => {
    await until(async () => (await status(purchaseId))?.state === state, `${purchaseId} ${state} (last ${JSON.stringify(await status(purchaseId))})`);
    const operation = await status(purchaseId); if (!operation) throw new Error('Missing operation');
    return operation;
  };
  const window = async (purchaseId: string) => {
    await until(async () => readPaymentWindowStatus((await call('payments.purchase.status', { purchaseId })).body).windows.length === 1, `${purchaseId} window`);
    const found = readPaymentWindowStatus((await call('payments.purchase.status', { purchaseId })).body).windows[0];
    if (!found) throw new Error('Missing window');
    return found;
  };
  const request = (purchaseId: string) => join(root, 'requests', `${Buffer.from(purchaseId).toString('base64url')}.json`);
  return { root, pairing, call, compose, begin, status, settled, window, request, page, effects, budget, durable };
}

test('a submit refused before the click settles as refused, releases everything, and stays refused after restart', async () => {
  const h = await harness(), f = h.compose(); await f.registration.ready;
  h.page.submit = async () => { throw new CheckoutSubmitRefused('The original checkout browser was replaced.'); };
  const purchaseId = await h.begin(), window = await h.window(purchaseId);
  expect((await h.call('payments.purchase.approve', { purchaseId, windowId: window.windowId, confirm: true })).status).toBe(200);
  const operation = await h.settled(purchaseId, 'refused');
  expect(operation).toMatchObject({ outcome: 'refused:submit-not-attempted', phase: null });
  expect(paymentOperationDescription(operation)).toContain('Nothing was submitted');
  expect(h.effects.filter(effect => effect === 'submit')).toHaveLength(1);
  expect(await h.durable.list()).toEqual([]); expect(h.budget.state().reservations).toEqual([]);
  await until(() => !existsSync(h.request(purchaseId)), 'protected request removal');
  // A settled purchase names its state instead of a generic refusal.
  const stop = await h.call('payments.purchase.cancel', { purchaseId, operationId: operation.operationId, confirm: true });
  expect(stop.status).toBe(409); expect(JSON.stringify(stop.body)).toContain('is refused and can no longer be stopped');
  const reconcile = await h.call('payments.purchase.reconcile', { purchaseId, operationId: operation.operationId, outcome: 'not-purchased', inspectedMerchantHistory: true, confirm: true });
  expect(reconcile.status).toBe(409); expect(JSON.stringify(reconcile.body)).toContain('is refused; only an uncertain');
  await f.close();
  const reopened = h.compose(); await reopened.registration.ready;
  expect(await h.status(purchaseId)).toMatchObject({ state: 'refused', outcome: 'refused:submit-not-attempted' });
});

test('a stop landing while submit-pending is flushed cancels before any click and still releases the hold', async () => {
  const h = await harness(), f = h.compose(); await f.registration.ready;
  const purchaseId = await h.begin(), window = await h.window(purchaseId);
  const operationId = (await h.status(purchaseId))?.operationId; if (!operationId) throw new Error('Missing operation');
  let acknowledgement: unknown;
  h.page.duringPut = async record => {
    if (record.phase !== 'submit-pending') return;
    acknowledgement = (await h.call('payments.purchase.cancel', { purchaseId, operationId, confirm: true })).body;
  };
  expect((await h.call('payments.purchase.approve', { purchaseId, windowId: window.windowId, confirm: true })).status).toBe(200);
  const operation = await h.settled(purchaseId, 'cancelled');
  expect(acknowledgement).toMatchObject({ accepted: true });
  expect(operation).toMatchObject({ outcome: 'cancelled', phase: null });
  expect(h.effects).not.toContain('submit');
  expect(await h.durable.list()).toEqual([]); expect(h.budget.state().reservations).toEqual([]);
  await until(() => !existsSync(h.request(purchaseId)), 'protected request removal');
});

test('an error after the click attempt stays uncertain and keeps its journal, hold and original request', async () => {
  const h = await harness(), f = h.compose(); await f.registration.ready;
  h.page.submit = async () => { throw new Error('The connection dropped mid-click'); };
  const purchaseId = await h.begin(), window = await h.window(purchaseId);
  expect((await h.call('payments.purchase.approve', { purchaseId, windowId: window.windowId, confirm: true })).status).toBe(200);
  expect(await h.settled(purchaseId, 'uncertain')).toMatchObject({ phase: 'submit-pending' });
  expect(h.effects.filter(effect => effect === 'submit')).toHaveLength(1);
  expect(await h.durable.list()).toMatchObject([{ purchaseId, phase: 'submit-pending' }]);
  expect(h.budget.state().reservations).toHaveLength(1); expect(existsSync(h.request(purchaseId))).toBe(true);
});

test('a card the page will not take is reported as a card-entry failure with nothing submitted', async () => {
  const h = await harness(), f = h.compose(); await f.registration.ready;
  h.page.fillFails = true;
  const purchaseId = await h.begin(), window = await h.window(purchaseId);
  expect((await h.call('payments.purchase.approve', { purchaseId, windowId: window.windowId, confirm: true })).status).toBe(200);
  const operation = await h.settled(purchaseId, 'refused');
  expect(operation.outcome).toBe('refused:card-fill-failed');
  expect(paymentOperationDescription(operation)).toContain('card could not be entered');
  expect(h.effects).not.toContain('submit');
});

/** The window is on the owner's screen and its checkpoint is durably saved. */
async function savedWindow(h: Awaited<ReturnType<typeof harness>>, purchaseId: string) {
  await h.window(purchaseId); await h.page.checkpointSaved.promise;
  const operationId = (await h.status(purchaseId))?.operationId; if (!operationId) throw new Error('Missing operation');
  return operationId;
}

test('a daemon stop during a saved window leaves it as a crash would, and boot recovery takes it back', async () => {
  const h = await harness(), f = h.compose(); await f.registration.ready;
  const purchaseId = await h.begin(), operationId = await savedWindow(h, purchaseId);
  const saved = await new ProtectedPaymentRequests(join(h.root, 'requests')).read(purchaseId, operationId, () => {});
  if (!saved.host.continuation || !saved.window) throw new Error('Missing continuation or window');
  // The daemon fills the card itself; a concurrent fill through the verb is refused.
  const fill = await h.call('payments.checkout.fillCard', { sessionId: 'session', pageId: 'page', targets: [{ field: 'number', ref: 'card' }] });
  expect(fill.status).toBe(400); expect(JSON.stringify(fill.body)).toContain('types the card itself');
  await f.close();
  const operations = new DurablePaymentOperations(join(h.root, 'operations'));
  // Nothing is settled: the operation, journal record, hold, request and continuation are what a kill -9 leaves.
  expect(operations.get(purchaseId)).toMatchObject({ state: 'running', phase: 'awaiting-window', outcome: null });
  expect(await h.durable.list()).toEqual([saved.window.record]);
  expect(h.budget.state().reservations).toHaveLength(1);
  expect(existsSync(h.request(purchaseId))).toBe(true);
  expect(h.pairing.readNativeContinuation(saved.host.continuation)).not.toBeNull();
  expect(h.effects).toEqual([]);
  // The next boot takes the window back exactly as it does after a crash.
  const boot = new CheckoutOperations(operations, h.durable, new DaemonPurchaseLedger({ filePath: join(h.root, 'purchases.json') }),
    async () => { throw new Error('Recovery cannot admit a fresh begin'); }, Date.now, new ProtectedPaymentRequests(join(h.root, 'requests')));
  cleanups.push(() => boot.close().catch(() => {}));
  await boot.retainInterruptedWindows(request => { retainResumedCheckoutHold(h.budget, request.window?.record ?? saved.window!.record); return async () => false; });
  expect(operations.retainRecovery(purchaseId)).toBeNull();
  await boot.recover();
  let resumed: string | undefined;
  const entered = Promise.withResolvers<void>();
  boot.resumeInterruptedWindows(async request => ({ source: { principalId: request.principalId, assertCurrent() {} }, input: request.input, release: async () => {},
    async execute(_input, id) { resumed = id; entered.resolve(); return { outcome: 'refused:no-card', purchaseId: id, reason: 'Fixture refusal', merchantOrderId: null,
      totalMinorUnits: null, currency: null, shippingTierUsed: null, steppedDown: false, challengeStep: null }; } }));
  await entered.promise;
  expect(resumed).toBe(purchaseId);
});

test('a daemon stop before the window checkpoint is saved is recorded as interrupted and releases everything', async () => {
  const h = await harness(), f = h.compose(); await f.registration.ready;
  const purchaseId = await h.begin(), operationId = await (async () => (await h.status(purchaseId))?.operationId ?? '')();
  let closing: Promise<void> | undefined;
  // The stop lands as the delivered window's journal record is flushed, before its checkpoint exists.
  h.page.duringPut = async record => { if (record.windowDeliveries && !closing) { closing = f.close(); h.page.stopRequested.resolve(); } };
  await h.page.stopRequested.promise;
  await closing;
  const operations = new DurablePaymentOperations(join(h.root, 'operations'));
  const operation = operations.get(purchaseId); if (!operation) throw new Error('Missing operation');
  expect(operation).toMatchObject({ state: 'interrupted', outcome: 'refused:daemon-stopped', operationId });
  expect(paymentOperationDescription(operation)).toContain('daemon stopped before this purchase was submitted');
  expect(await h.durable.list()).toEqual([]); expect(h.budget.state().reservations).toEqual([]);
  expect(h.effects).toEqual([]);
});

test('a daemon stop during the checkpoint write lets the write finish and then leaves the window for restart', async () => {
  const h = await harness(), f = h.compose(); await f.registration.ready;
  let closing: Promise<void> | undefined;
  h.page.beforeCheckpointSave = () => { if (!closing) { closing = f.close(); h.page.stopRequested.resolve(); } };
  const purchaseId = await h.begin();
  await h.page.stopRequested.promise;
  await closing;
  const operations = new DurablePaymentOperations(join(h.root, 'operations'));
  const operation = operations.get(purchaseId); if (!operation) throw new Error('Missing operation');
  const saved = await new ProtectedPaymentRequests(join(h.root, 'requests')).read(purchaseId, operation.operationId, () => {});
  expect(operation).toMatchObject({ state: 'running', phase: 'awaiting-window', outcome: null });
  expect(saved.window?.record).toEqual((await h.durable.list())[0]);
  expect(h.budget.state().reservations).toHaveLength(1); expect(h.effects).toEqual([]);
});

test('an owner stop that races a daemon stop still cancels, releases the hold and revokes the continuation', async () => {
  const h = await harness(), f = h.compose(); await f.registration.ready;
  const purchaseId = await h.begin(), operationId = await savedWindow(h, purchaseId);
  const saved = await new ProtectedPaymentRequests(join(h.root, 'requests')).read(purchaseId, operationId, () => {});
  const continuation = saved.host.continuation; if (!continuation) throw new Error('Missing issued continuation');
  expect((await h.call('payments.purchase.cancel', { purchaseId, operationId, confirm: true })).status).toBe(200);
  await f.close();
  const operations = new DurablePaymentOperations(join(h.root, 'operations'));
  expect(operations.get(purchaseId)).toMatchObject({ state: 'cancelled', outcome: 'cancelled' });
  expect(await h.durable.list()).toEqual([]); expect(h.budget.state().reservations).toEqual([]);
  expect(h.pairing.readNativeContinuation(continuation)).toBeNull();
  expect(existsSync(h.request(purchaseId))).toBe(false); expect(h.effects).toEqual([]);
});

test('a daemon stop once the card is being armed releases the window instead of leaving it', async () => {
  const h = await harness(), f = h.compose(); await f.registration.ready;
  let closing: Promise<void> | undefined;
  h.page.duringPut = async record => { if (record.phase === 'arming-payment' && !closing) { closing = f.close(); h.page.stopRequested.resolve(); } };
  const purchaseId = await h.begin(), window = await h.window(purchaseId);
  await savedWindow(h, purchaseId);
  expect((await h.call('payments.purchase.approve', { purchaseId, windowId: window.windowId, confirm: true })).status).toBe(200);
  await h.page.stopRequested.promise;
  await closing;
  const operations = new DurablePaymentOperations(join(h.root, 'operations'));
  expect(operations.get(purchaseId)).toMatchObject({ state: 'interrupted', outcome: 'refused:daemon-stopped' });
  expect(await h.durable.list()).toEqual([]); expect(h.budget.state().reservations).toEqual([]);
  expect(h.effects).not.toContain('submit');
});

test('an owner stop during the window is cancelled and still releases the hold and revokes the continuation', async () => {
  const h = await harness(), f = h.compose(); await f.registration.ready;
  const purchaseId = await h.begin(); await h.window(purchaseId);
  const before = await h.status(purchaseId); if (!before) throw new Error('Missing operation');
  const saved = await new ProtectedPaymentRequests(join(h.root, 'requests')).read(purchaseId, before.operationId, () => {});
  const continuation = saved.host.continuation; if (!continuation) throw new Error('Missing issued continuation');
  expect((await h.call('payments.purchase.cancel', { purchaseId, operationId: before.operationId, confirm: true })).status).toBe(200);
  expect(await h.settled(purchaseId, 'cancelled')).toMatchObject({ outcome: 'cancelled' });
  expect(h.effects).toEqual([]);
  expect(await h.durable.list()).toEqual([]); expect(h.budget.state().reservations).toEqual([]);
  await until(() => h.pairing.readNativeContinuation(continuation) === null, 'continuation revocation');
  await until(() => !existsSync(h.request(purchaseId)), 'protected request removal');
});

test('a page held by a merchant check frees once the owner reconciles it', async () => {
  const h = await harness(), f = h.compose(); await f.registration.ready;
  h.page.submit = async () => ({ url: 'https://www.bestbuy.com/verify', orderId: null, verified: false,
    challenge: { kind: '3d-secure', step: 'Approve the payment in your bank app.', url: 'https://www.bestbuy.com/verify' } });
  const first = await h.begin(), window = await h.window(first);
  expect((await h.call('payments.purchase.approve', { purchaseId: first, windowId: window.windowId, confirm: true })).status).toBe(200);
  const attention = await h.settled(first, 'attention');
  // While the check is open, another checkout on the same page is told why.
  const blocked = await h.begin();
  const refused = await h.settled(blocked, 'refused');
  expect(refused.outcome).toBe('refused:page-in-use');
  expect(paymentOperationDescription(refused)).toContain('already has a checkout');
  const reconciled = await h.call('payments.purchase.reconcile', { purchaseId: first, operationId: attention.operationId, outcome: 'not-purchased', inspectedMerchantHistory: true, confirm: true });
  expect(reconciled.status).toBe(200);
  const next = await h.begin();
  await h.window(next);
  expect(await h.status(next)).toMatchObject({ state: 'running', phase: 'awaiting-window' });
  expect(h.effects.filter(effect => effect === 'submit')).toHaveLength(1);
});

/** A daemon stop in a saved window, as the harness's next boot finds it: operation, journal record, hold, request and continuation. */
async function stoppedInSavedWindow() {
  const h = await harness(), f = h.compose(); await f.registration.ready;
  const purchaseId = await h.begin(), operationId = await savedWindow(h, purchaseId);
  const saved = await new ProtectedPaymentRequests(join(h.root, 'requests')).read(purchaseId, operationId, () => {});
  if (!saved.host.continuation) throw new Error('Missing continuation');
  await f.close();
  expect(await h.durable.list()).toHaveLength(1); expect(h.budget.state().reservations).toHaveLength(1);
  return { h, purchaseId, continuation: saved.host.continuation };
}

test('a window the next boot cannot restore is settled as not submitted and its hold released', async () => {
  const { h, purchaseId } = await stoppedInSavedWindow();
  // The same host, now without a restorer for saved windows: nothing can resume it, so the sweep must settle it.
  const reopened = h.compose(); await reopened.registration.ready;
  expect(await h.durable.list()).toEqual([]); expect(h.budget.state().reservations).toEqual([]);
  expect(await h.status(purchaseId)).toMatchObject({ state: 'interrupted', outcome: 'refused:daemon-stopped' });
  expect(h.effects).not.toContain('submit');
});

test('a window whose restoration is refused at boot (payments disabled, or authority gone) is released, never resumed', async () => {
  const { h, purchaseId, continuation } = await stoppedInSavedWindow();
  let refused = 0;
  const reopened = h.compose({ restoreWindow: async () => { refused++; throw new CheckoutOwnershipError(); },
    retireContinuation: grant => { h.pairing.revokeNativeContinuation(grant); } });
  await reopened.registration.ready;
  await until(async () => (await h.status(purchaseId))?.state === 'refused', 'the refused window to settle');
  expect(refused).toBe(1);
  expect(await h.durable.list()).toEqual([]); expect(h.budget.state().reservations).toEqual([]);
  await until(() => !existsSync(h.request(purchaseId)), 'protected request removal');
  expect(h.pairing.readNativeContinuation(continuation)).toBeNull();
  expect(h.effects).not.toContain('submit');
});
