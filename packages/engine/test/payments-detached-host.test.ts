import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../sdk/src/platform/daemon/control-plane.js';
import { PairingTokenManager } from '../sdk/src/platform/pairing/pairing-token-store.js';
import { BudgetLedger } from '../sdk/src/platform/payments/budget.js';
import { CardMaterialRedactor } from '../sdk/src/platform/payments/card-redaction.js';
import { DurableCheckoutJournal } from '../sdk/src/platform/payments/host/checkout-journal-store.js';
import { DurablePaymentOperations } from '../sdk/src/platform/payments/host/operation-store.js';
import { DaemonApprovalStore } from '../sdk/src/platform/payments/host/approval-store.js';
import { DaemonCardStore } from '../sdk/src/platform/payments/host/card-store.js';
import { DaemonPurchaseLedger } from '../sdk/src/platform/payments/host/purchase-ledger.js';
import { configBackedAddressStore } from '../sdk/src/platform/payments/host/address-store.js';
import { channelBackedPaymentNotifier } from '../sdk/src/platform/payments/host/notifier.js';
import { registerPaymentsMethods } from '../sdk/src/platform/payments/host/register.js';
import { createJevMerchantJudge } from '../sdk/src/platform/payments/merchant-judge-model.js';
import { PaymentReplyInbox } from '../sdk/src/platform/payments/reply-inbox.js';
import { readPaymentWindowStatus } from '../sdk/src/platform/payments/browser.js';
import { getProcessUntrustedContentLedger } from '../sdk/src/platform/security/untrusted-content.js';
import { configureDecisionModelPolicy } from '../sdk/src/platform/runtime/decision-policy.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { usePaymentsReadings } from './helpers/payments-readings.ts';

usePaymentsReadings();
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2000;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Detached payment fixture did not settle'); await new Promise(resolve => setTimeout(resolve, 1)); }
}

test('the actual paired dispatcher acknowledges before its window, survives socket abort and retains final status after recomposition', async () => {
  cleanups.push(configureDecisionModelPolicy(() => 'Default - On'));
  const root = makeProjectTempDir('detached-payment-host'), catalog = new GatewayMethodCatalog();
  const pairing = new PairingTokenManager(join(root, 'pairing.json')), paired = pairing.mint({ name: 'Synthetic payment owner' });
  const helper = new DaemonControlPlaneHelper({ gatewayMethods: catalog, pairingTokens: pairing, authToken: () => 'synthetic-shared',
    userAuth: { validateSession: () => null } } as unknown as DaemonControlPlaneContext);
  const values: Record<string, unknown> = { 'payments.enabled': true, 'payments.budget.dailyItem': 100,
    'payments.budget.dailyOverage': 100, 'payments.budget.perPurchaseCeiling': 100, 'payments.notifyChannels': 'telegram', 'payments.cvvHandling': 'stored' };
  for (const [key, value] of Object.entries({ name: 'Fixture owner', line1: '1 Fixture Street', city: 'Fixture City', region: 'TS', postalCode: '00000', country: 'US' })) values[`payments.shippingAddress.${key}`] = value;
  const config = { get: (key: string) => values[key] }, secrets = new Map<string, string>(), effects: string[] = [];
  const cards = new DaemonCardStore({ filePath: join(root, 'cards.json'), cvvHandling: () => 'stored', secrets: {
    async get(key) { return secrets.get(key) ?? null; }, async set(key, value) { secrets.set(key, value); }, async delete(key) { secrets.delete(key); },
  } });
  const card = await cards.create({ label: 'Synthetic test card', kind: 'virtual', number: '4111111111111111', expiryMonth: 1, expiryYear: 2030,
    cvv: '123', cardholderName: 'Fixture owner', issuerCapMinorUnits: null });
  const compose = () => {
    const replies = new PaymentReplyInbox(), operations = new DurablePaymentOperations(join(root, 'operations'));
    const registration = registerPaymentsMethods(catalog, { cards, config, budget: new BudgetLedger(), isPaymentsLeader: () => true,
      purchases: new DaemonPurchaseLedger({ filePath: join(root, 'purchases.json') }), checkout: {
        operations, replies, journal: new DurableCheckoutJournal(join(root, 'journal.json')), approvals: new DaemonApprovalStore(join(root, 'approvals.json')),
        addresses: configBackedAddressStore(config), untrusted: getProcessUntrustedContentLedger(), merchantJudge: createJevMerchantJudge(),
        notifier: channelBackedPaymentNotifier(config, { async deliver(request) { request.assertCurrent?.(); return 'synthetic-delivery'; } }, replies),
        seam: (() => {
          const seam = { cardFieldGuard: new CardMaterialRedactor(), armSubmitApproval: async () => {}, driverFor: () => ({
            identity: () => ({ sessionId: 'session', pageId: 'page' }), async url() { return 'https://www.bestbuy.com/checkout'; },
            async fill() { effects.push('fill'); }, async choose() { effects.push('choose'); },
            async fillSecrets() { effects.push('card'); return { filledTargets: [], failedTarget: null }; },
            async submitOrder() { effects.push('submit'); return { url: 'https://www.bestbuy.com/done', orderId: null, verified: false }; },
          }) }; return () => seam;
        })(),
      } });
    const close = async () => { await Promise.all([registration.close(), replies.close()]); };
    cleanups.push(close); return { registration, replies, operations, close };
  };
  const call = (methodId: string, body: Record<string, unknown> = {}, signal?: AbortSignal) => helper.invokeGatewayMethodCall({ methodId, body, signal, authToken: paired.token,
    context: { ...helper.describeAuthenticatedPrincipal(paired.token), explicitUserRequest: true } });
  const f = compose(); await f.registration.ready;
  const identity = { merchantDomain: 'bestbuy.com', item: 'Fixture item' };
  expect((await call('payments.checkout.approve', { ...identity, amount: '11.00', confirm: true })).status).toBe(200);
  const request = new AbortController();
  const body = { ...identity, requestId: 'stable-owner-request', requestedMax: '11.00', sessionId: 'session', pageId: 'page', checkoutUrl: 'https://www.bestbuy.com/checkout', cardId: card.id,
    requestedLines: [{ label: 'Fixture item', quantity: 1 }], lines: [{ label: 'Fixture item', quantity: '1', unitPrice: '$10.00' }],
    shippingOptions: [{ label: 'Standard', cost: '$0.00' }], cardFields: [{ field: 'number', ref: 'card' }], placeOrderTarget: 'submit' };
  const acknowledged = await call('payments.checkout.begin', body, request.signal);
  expect(acknowledged.status).toBe(200); expect(acknowledged.body).toMatchObject({ outcome: 'accepted', purchaseId: body.requestId });
  request.abort(); body.item = 'altered after acknowledgement';
  await until(() => f.replies.inspect().length === 1);
  const status = readPaymentWindowStatus((await call('payments.purchase.status')).body);
  expect(status.operations[0]).toMatchObject({ purchaseId: body.requestId, state: 'running', phase: 'awaiting-window' });
  const window = status.windows[0]; if (!window) throw new Error('Expected the real reply window');
  expect(window.notice).toContain('Fixture item'); expect(window.notice).not.toContain(body.item);
  expect((await call('payments.purchase.cancel', { purchaseId: window.purchaseId, windowId: window.windowId, confirm: true })).status).toBe(200);
  await until(() => f.operations.get(body.requestId)?.state === 'cancelled');
  expect(effects).toEqual([]);
  expect((await call('payments.checkout.begin', body)).status).toBe(409);
  await f.close();
  const reopened = compose(); await reopened.registration.ready;
  const recovered = readPaymentWindowStatus((await call('payments.purchase.status')).body);
  expect(recovered.windows).toEqual([]); expect(recovered.operations[0]?.state).toBe('cancelled');
  expect((await call('payments.checkout.begin', body)).status).toBe(409);
  expect(effects).toEqual([]);
});
