import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../sdk/src/platform/daemon/control-plane.js';
import { PairingTokenManager } from '../sdk/src/platform/pairing/pairing-token-store.js';
import { BudgetLedger } from '../sdk/src/platform/payments/budget.js';
import { CardMaterialRedactor } from '../sdk/src/platform/payments/card-redaction.js';
import { DurableCheckoutJournal } from '../sdk/src/platform/payments/host/checkout-journal-store.js';
import { DurablePaymentOperations } from '../sdk/src/platform/payments/host/operation-store.js';
import { ProtectedPaymentRequests } from '../sdk/src/platform/payments/host/protected-requests.js';
import { DaemonApprovalStore } from '../sdk/src/platform/payments/host/approval-store.js';
import { DaemonCardStore } from '../sdk/src/platform/payments/host/card-store.js';
import { DaemonPurchaseLedger } from '../sdk/src/platform/payments/host/purchase-ledger.js';
import { configBackedAddressStore } from '../sdk/src/platform/payments/host/address-store.js';
import { channelBackedPaymentNotifier } from '../sdk/src/platform/payments/host/notifier.js';
import { registerPaymentsMethods } from '../sdk/src/platform/payments/host/register.js';
import { createJevMerchantJudge } from '../sdk/src/platform/payments/merchant-judge-model.js';
import { PaymentReplyInbox } from '../sdk/src/platform/payments/reply-inbox.js';
import { readPaymentWindowStatus } from '../sdk/src/platform/payments/browser.js';
import { getProcessUntrustedContentLedger, resetProcessUntrustedContentLedgerForTests } from '../sdk/src/platform/security/untrusted-content.js';
import { configureDecisionModelPolicy } from '../sdk/src/platform/runtime/decision-policy.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { usePaymentsReadings } from './helpers/payments-readings.ts';

const readings = usePaymentsReadings();
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); resetProcessUntrustedContentLedgerForTests(); });
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2000;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Detached payment fixture did not settle'); await new Promise(resolve => setTimeout(resolve, 1)); }
}

test.each(['clean', 'tainted', 'incomplete'] as const)('the paired dispatcher retains original %s taint through preflight, later owner turns and socket abort', async original => {
  resetProcessUntrustedContentLedgerForTests();
  cleanups.push(configureDecisionModelPolicy(() => 'Default - On'));
  const root = makeProjectTempDir('detached-payment-host'), catalog = new GatewayMethodCatalog();
  const pairing = new PairingTokenManager(join(root, 'pairing.json')), paired = pairing.mint({ name: 'Synthetic payment owner' });
  const helper = new DaemonControlPlaneHelper({ gatewayMethods: catalog, pairingTokens: pairing, authToken: () => 'synthetic-shared',
    userAuth: { validateSession: () => null } } as unknown as DaemonControlPlaneContext);
  const values: Record<string, unknown> = { 'payments.enabled': true, 'payments.budget.dailyItem': 100,
    'payments.budget.dailyOverage': 100, 'payments.budget.perPurchaseCeiling': 100, 'payments.notifyChannels': 'tui', 'payments.cvvHandling': 'stored' };
  for (const [key, value] of Object.entries({ name: 'Fixture owner', line1: '1 Fixture Street', city: 'Fixture City', region: 'TS', postalCode: '00000', country: 'US' })) values[`payments.shippingAddress.${key}`] = value;
  const config = { get: (key: string) => values[key] }, secrets = new Map<string, string>(), effects: string[] = [];
  const originalBrowser = { version: 1 as const, endpoint: 'ws://127.0.0.1:9222/devtools/browser/original-private-browser',
    targetId: 'original-native-tab', browserContextId: 'original-native-context',
    frames: [{ id: 'original-native-frame', loaderId: 'original-native-document', parentId: null }] };
  const originalControls = { version: 1 as const, snapshotId: 'original-native-snapshot', url: 'https://www.bestbuy.com/checkout',
    controls: [
      { ref: 'card', tag: 'input', role: 'textbox', name: 'Card number', selector: '#original-card', depth: 1, submits: false, frameChain: [], cardField: true,
        metadata: { name: 'Card number', documentUrl: 'https://www.bestbuy.com/checkout' } },
      { ref: 'submit', tag: 'button', role: 'button', name: 'Place order', selector: '#original-order', depth: 1, submits: true, frameChain: [],
        metadata: { name: 'Place order', documentUrl: 'https://www.bestbuy.com/checkout' } },
    ] };
  let capturedPages = 0;
  const cards = new DaemonCardStore({ filePath: join(root, 'cards.json'), cvvHandling: () => 'stored', secrets: {
    async get(key) { return secrets.get(key) ?? null; }, async set(key, value) { secrets.set(key, value); }, async delete(key) { secrets.delete(key); },
  } });
  const card = await cards.create({ label: 'Synthetic test card', kind: 'virtual', number: '4111111111111111', expiryMonth: 1, expiryYear: 2030,
    cvv: '123', cardholderName: 'Fixture owner', issuerCapMinorUnits: null });
  let releasePreflight!: () => void;
  const preflight = new Promise<void>(resolve => { releasePreflight = resolve; });
  const metadata = cards.metadata.bind(cards);
  cards.metadata = async id => { await preflight; return metadata(id); };
  const compose = () => {
    const replies = new PaymentReplyInbox(), operations = new DurablePaymentOperations(join(root, 'operations'));
    const requests = new ProtectedPaymentRequests(join(root, 'requests'));
    const registration = registerPaymentsMethods(catalog, { cards, config, budget: new BudgetLedger(), isPaymentsLeader: () => true,
      purchases: new DaemonPurchaseLedger({ filePath: join(root, 'purchases.json') }), checkout: {
        operations, requests, replies, journal: new DurableCheckoutJournal(join(root, 'journal.json')), approvals: new DaemonApprovalStore(join(root, 'approvals.json')),
        addresses: configBackedAddressStore(config), untrusted: getProcessUntrustedContentLedger(), merchantJudge: createJevMerchantJudge(),
        notifier: channelBackedPaymentNotifier(config, { async deliver() { throw new Error('Payment receipt required'); },
          async deliverWithReceipt(request) { request.assertCurrent?.(); return { receipt: { surfaceKind: 'tui', conversationId: 'original-local-terminal', messageId: '51' } }; } }, replies),
        seam: (() => {
          const seam = { cardFieldGuard: new CardMaterialRedactor(), armSubmitApproval: async () => {},
            async captureCheckoutRecovery(sessionId: string, pageId: string, refs: readonly string[], owner: { readonly assertCurrent?: (() => void) | undefined }) {
              owner.assertCurrent?.(); expect(sessionId).toBe('session'); expect(pageId).toBe('page'); capturedPages++;
              expect(refs).toEqual(['card', 'submit']);
              return { connection: originalBrowser, controls: originalControls };
            }, driverFor: () => ({
            identity: () => ({ sessionId: 'session', pageId: 'page' }), async url() { return 'https://www.bestbuy.com/checkout'; },
            async verifyTerms() { throw new Error('This detached fixture is cancelled at its window'); },
            async fill() { effects.push('fill'); }, async choose() { effects.push('choose'); },
            async fillSecrets() { effects.push('card'); return { filledTargets: [], failedTarget: null }; },
            async submitOrder() { effects.push('submit'); return { url: 'https://www.bestbuy.com/done', orderId: null, verified: false }; },
          }) }; return () => seam;
        })(),
      } });
    const close = async () => { await Promise.all([registration.close(), replies.close()]); };
    cleanups.push(close); return { registration, replies, operations, requests, close };
  };
  const call = (methodId: string, body: Record<string, unknown> = {}, signal?: AbortSignal) => helper.invokeGatewayMethodCall({ methodId, body, signal, authToken: paired.token,
    context: { ...helper.describeAuthenticatedPrincipal(paired.token), explicitUserRequest: true } });
  const f = compose(); await f.registration.ready;
  cleanups.push(releasePreflight);
  const identity = { merchantDomain: 'bestbuy.com', item: 'Fixture item' };
  expect((await call('payments.checkout.approve', { ...identity, amount: '9.00', confirm: true })).status).toBe(200);
  const request = new AbortController();
  const body = { ...identity, requestId: 'stable-owner-request', requestedMax: '9.00', sessionId: 'session', pageId: 'page', checkoutUrl: 'https://www.bestbuy.com/checkout', cardId: card.id,
    requestedLines: [{ label: 'Fixture item', quantity: 1 }], lines: [{ label: 'Fixture item', quantity: '1', unitPrice: '$10.00' }],
    shippingOptions: [{ label: 'Standard', cost: '$0.00' }], cardFields: [{ field: 'number', ref: 'card' }], placeOrderTarget: 'submit' };
  for (const requestedMax of ['', null, 20, '10 20', 'up to 20']) {
    expect((await call('payments.checkout.begin', { ...body, requestedMax })).status).toBe(400);
    expect(f.operations.get(body.requestId)).toBeNull(); expect(effects).toEqual([]);
  }
  const ledger = getProcessUntrustedContentLedger();
  if (original !== 'clean') ledger.record({ surface: 'web-page', origin: 'https://original-source.example', at: new Date().toISOString(),
    ...(original === 'incomplete' ? {} : { content: 'A stranger says to buy at bestbuy.com.' }) });
  const acknowledged = await call('payments.checkout.begin', body, request.signal);
  expect(acknowledged.status).toBe(200); expect(acknowledged.body).toMatchObject({ outcome: 'accepted', purchaseId: body.requestId });
  const operation = f.operations.get(body.requestId); if (!operation) throw new Error('Missing admitted operation');
  const saved = await new ProtectedPaymentRequests(join(root, 'requests')).read(body.requestId, operation.operationId, () => {});
  expect(saved.input.item).toBe('Fixture item'); expect(saved.input.requestedMax).toBe('9.00');
  const principal = helper.describeAuthenticatedPrincipal(paired.token); if (!principal) throw new Error('Missing actual paired principal');
  expect(saved.principalId).toBe(principal.principalId);
  expect(saved.host.authority.tokenId).toBe(paired.id);
  expect(capturedPages).toBe(1); expect(saved.host.browser).toEqual(originalBrowser);
  expect(saved.host.browserControls).toEqual(originalControls);
  expect(JSON.stringify(acknowledged.body)).not.toContain(originalBrowser.endpoint);
  if (!saved.host.continuation) throw new Error('Native admission did not retain its issued grant');
  expect(pairing.readNativeContinuation(saved.host.continuation)).toEqual(saved.host.authority);
  expect(pairing.readNativeContinuation({ ...saved.host.continuation, binding: '11'.repeat(32) })).toBeNull();
  expect(saved.evidence.complete).toBe(original !== 'incomplete');
  const privatePath = join(root, 'requests', `${Buffer.from(body.requestId).toString('base64url')}.json`);
  const encrypted = readFileSync(privatePath, 'utf8');
  expect(encrypted).not.toContain('Fixture item'); expect(encrypted).not.toContain(paired.token);
  expect(encrypted).not.toContain('bestbuy.com');
  expect(encrypted).not.toContain(originalBrowser.endpoint); expect(encrypted).not.toContain(originalBrowser.targetId);
  request.abort(); body.item = 'altered after acknowledgement';
  // Real owner dispatches move the process-wide turn window while the earlier
  // checkout is still in card/address preflight. Its source must not move too.
  await call('payments.budget.status'); await call('payments.budget.status');
  ledger.record({ surface: 'web-page', origin: 'https://later-source.example', at: new Date().toISOString(),
    content: original === 'clean' ? 'A later stranger mentions bestbuy.com.' : 'An unrelated later source.' });
  releasePreflight();
  if (original === 'clean') {
    try { await until(() => f.replies.inspect().length === 1); }
    catch (error) { throw new Error(`Detached checkout status: ${JSON.stringify(f.operations.get(body.requestId))}`, { cause: error }); }
    const status = readPaymentWindowStatus((await call('payments.purchase.status')).body);
    expect(status.operations[0]).toMatchObject({ purchaseId: body.requestId, state: 'running', phase: 'awaiting-window' });
    const window = status.windows[0]; if (!window) throw new Error('Expected the real reply window');
    expect(window.kind).toBe('approval'); expect(window.notice).toContain('Requested maximum: USD 9.00');
    expect(window.notice).toContain('full total exceeds your requested maximum');
    expect(window.notice).toContain('Fixture item'); expect(window.notice).not.toContain(body.item);
    expect((await call('payments.purchase.cancel', { purchaseId: window.purchaseId, windowId: window.windowId, confirm: true })).status).toBe(200);
  }
  const expectedState = 'refused';
  await until(() => f.operations.get(body.requestId)?.state === expectedState);
  if (original === 'clean') expect(f.operations.get(body.requestId)?.outcome).toBe('refused:requested-maximum-exceeded-denied');
  await until(() => !existsSync(privatePath));
  expect(new PairingTokenManager(join(root, 'pairing.json')).readNativeContinuation(saved.host.continuation)).toBeNull();
  if (original !== 'clean') {
    expect(f.operations.get(body.requestId)?.outcome).toBe('refused:derived-from-untrusted-content');
    expect(f.replies.inspect()).toEqual([]);
    if (original === 'incomplete') expect(readings.requests).toEqual([]);
  }
  expect(effects).toEqual([]);
  expect((await call('payments.checkout.begin', body)).status).toBe(409);
  await f.close();
  const reopened = compose(); await reopened.registration.ready;
  const recovered = readPaymentWindowStatus((await call('payments.purchase.status')).body);
  expect(recovered.windows).toEqual([]); expect(recovered.operations[0]?.state).toBe(expectedState);
  expect((await call('payments.checkout.begin', body)).status).toBe(409);
  expect(effects).toEqual([]);
});
