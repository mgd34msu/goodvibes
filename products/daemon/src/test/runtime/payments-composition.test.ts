import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { GatewayMethodCatalog, prepareGatewayScopePolicyOwner, completeGatewayScopePolicyBootstrap } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { DurablePaymentOperations } from '@goodvibes-jev/engine/sdk/platform/payments';
import { readPaymentsServiceConfig } from '../../../../../packages/engine/sdk/src/platform/payments/payments-config.js';
import { paymentContinuationBinding } from '../../../../../packages/engine/sdk/src/platform/payments/host/continuation-binding.js';
import { protectedPaymentRequest } from '../../../../../packages/engine/test/helpers/protected-payment-request.js';
import { protectedPaymentWindow } from '../../../../../packages/engine/test/helpers/protected-payment-window.js';
import { ATTACHED_PAYMENTS_METHOD_IDS, CardMaterialRedactor, DurableCheckoutJournal, ProtectedPaymentRequests, PaymentReplyInboxClosedError, parseCurrencyCode, ownerSuppliedText, type CheckoutPageDriver, type InFlightCheckout, type PurchaseRecord } from '@goodvibes-jev/engine/sdk/platform/payments';
import { PairingTokenManager } from '@goodvibes-jev/engine/sdk/platform/pairing';
import { readPaymentWindowStatus } from '@goodvibes-jev/engine/sdk/platform/payments/browser';
import { resetProcessUntrustedContentLedgerForTests } from '@goodvibes-jev/engine/sdk/platform/security';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../../../../../packages/engine/sdk/src/platform/daemon/control-plane.js';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createPaymentsServices } from '../../runtime/payments-composition.js';
import { createBrowserCheckoutSeamHolder } from '../../runtime/browser-checkout-seam-holder.js';
import { createShellPathService } from '../../runtime/index.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const callers = new WeakMap<GatewayMethodCatalog, (id: string, body: unknown) => Promise<Record<string, unknown>>>();
beforeEach(resetProcessUntrustedContentLedgerForTests);
afterEach(resetProcessUntrustedContentLedgerForTests);
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('Actual product payment operation did not settle');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

function fixture(catalog = new GatewayMethodCatalog()) {
  const root = makeOwnedTempDir('daemon-payments');
  const pairing = new PairingTokenManager(join(root, 'pairing.json')), paired = pairing.mint({ name: 'Synthetic product payment owner' });
  const dispatcher = new DaemonControlPlaneHelper({ gatewayMethods: catalog, pairingTokens: pairing, authToken: () => 'synthetic-unused-shared',
    userAuth: { validateSession: () => null } } as unknown as DaemonControlPlaneContext);
  callers.set(catalog, async (methodId, body) => {
    const result = await dispatcher.invokeGatewayMethodCall({ methodId, body, authToken: paired.token,
      context: { ...dispatcher.describeAuthenticatedPrincipal(paired.token), explicitUserRequest: true } });
    if (result.status !== 200) throw Object.assign(new Error('Fixture gateway refusal'), { status: result.status, body: result.body });
    if (!result.body || typeof result.body !== 'object' || Array.isArray(result.body)) throw new Error('Expected object response');
    return result.body as Record<string, unknown>;
  });
  const values: Record<string, unknown> = { 'payments.enabled': true, 'payments.budget.dailyItem': 100, 'payments.budget.dailyOverage': 100, 'payments.budget.perPurchaseCeiling': 100, 'payments.notifyChannels': 'tui', 'payments.cvvHandling': 'stored' };
  for (const [key, value] of Object.entries({ name: 'Fixture owner', line1: '1 Fixture Street', city: 'Fixture City', region: 'TS', postalCode: '00000', country: 'US' })) values[`payments.shippingAddress.${key}`] = value;
  const secrets = new Map<string, string>();
  const scopes: unknown[] = [];
  const deliveries: unknown[] = [];
  const browser = createBrowserCheckoutSeamHolder();
  let leader = true;
  const options = {
    configManager: { get: (key: string) => values[key] } as Pick<ConfigManager, 'get'>,
    shellPaths: createShellPathService({ workingDirectory: join(root, 'workspace'), homeDirectory: join(root, 'home') }),
    secretsManager: {
      async get(key: string) { return secrets.get(key) ?? null; },
      async set(key: string, value: string, options?: unknown) { scopes.push(options); secrets.set(key, value); },
      async delete(key: string) { secrets.delete(key); },
    },
    gatewayMethods: catalog, isPaymentsLeader: () => leader, checkoutSeam: browser.get,
    channelDeliveryRouter: { async deliver(request: unknown) { deliveries.push(request); return 'fixture-notice'; },
      async deliverWithReceipt(request: unknown) { deliveries.push(request); return { receipt: { surfaceKind: 'tui' as const, conversationId: 'original-terminal', messageId: 'fixture-notice' } }; } },
  };
  const services = createPaymentsServices(options);
  return { root, values, scopes, deliveries, browser, catalog, options, services, pairing, setLeader(value: boolean) { leader = value; } };
}

function invoke(catalog: GatewayMethodCatalog, id: string, body: unknown = {}) {
  const call = callers.get(catalog); if (!call) throw new Error('Missing actual paired dispatcher');
  return call(id, body);
}

test('real product payments register on the existing catalog and read live owner limits/leadership', async () => {
  const f = fixture();
  try {
    await f.services.ready;
    for (const id of ATTACHED_PAYMENTS_METHOD_IDS) expect(f.catalog.hasHandler(id)).toBe(true);
    expect(await invoke(f.catalog, 'payments.cards.list')).toMatchObject({ cards: [] });
    expect(await invoke(f.catalog, 'payments.budget.status')).toMatchObject({ isPaymentsLeader: true });
    f.setLeader(false);
    expect(await invoke(f.catalog, 'payments.budget.status')).toMatchObject({ isPaymentsLeader: false });
    f.values['payments.budget.dailyItem'] = 321;
    expect(JSON.stringify(await invoke(f.catalog, 'payments.budget.status'))).toContain('32100');
    expect(f.deliveries).toEqual([]);
    expect(f.scopes).toEqual([]);
  } finally { await f.services.close(); }
  for (const id of ATTACHED_PAYMENTS_METHOD_IDS) expect(f.catalog.hasHandler(id)).toBe(false);
});

test('closing before registration settles cannot leave handlers or an answerable window behind', async () => {
  const f = fixture();
  const waiting = f.services.paymentReplies.waitForAnswer({ purchaseId: 'fixture-veto', kind: 'veto', channels: ['telegram'], notice: 'fixture', deadlineMs: Date.now() + 60_000 });
  const closing = f.services.close();
  expect(f.services.close()).toBe(closing);
  await expect(waiting).rejects.toBeInstanceOf(PaymentReplyInboxClosedError);
  await closing;
  for (const id of ATTACHED_PAYMENTS_METHOD_IDS) expect(f.catalog.hasHandler(id)).toBe(false);
  // Reusing the catalog is safe only after the old close has finished.
  const replacement = createPaymentsServices(f.options);
  try {
    await replacement.ready;
    f.services.unregister();
    for (const id of ATTACHED_PAYMENTS_METHOD_IDS) expect(f.catalog.hasHandler(id)).toBe(true);
    expect(replacement.paymentReplies).not.toBe(f.services.paymentReplies);
  } finally { await replacement.close(); }
});

/** Fixed fixture readings, no inference or external model calls in a unit test. */
function fixturePort(): NonNullable<Parameters<typeof installJudgmentPort>[0]> {
  return {
    model: 'jev-1.13.0',
    async ask(request) {
      const battery = request.context?.battery;
      const allowed = ['engine.security.link-host', 'engine.payments.merchant', 'engine.payments.cart-line', 'engine.payments.recurring-charge', 'engine.payments.shipping-standard', 'engine.payments.shipping-fast', 'engine.payments.shipping-fastest', 'engine.payments.veto-reply'];
      if (!allowed.includes(battery ?? '')) throw new Error(`Unexpected fixture reading: ${battery}`);
      const answers = Object.fromEntries(Object.entries(request.questions).map(([name, question]) => {
        if (question.type === 'noul') return [name, { type: 'noul', noul: ['qualifies', 'fits_0'].includes(name) ? 0.999 : 0.001 }];
        if (question.type !== 'choice') throw new Error('Unexpected fixture question');
        const state = request.state as { candidates?: readonly { id: string }[] };
        const chosen = name === 'recourse' ? 'retailer' : name === 'pick' ? state.candidates?.[0]?.id : 'object';
        if (!chosen || !(chosen in question.criteria)) throw new Error('Unexpected fixture choice');
        return [name, { type: 'choice', choice: chosen, confidence: 0.999, probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === chosen ? 0.999 : 0.001 / (Object.keys(question.criteria).length - 1)])) }];
      }));
      return { answers: answers as never, model: 'jev-1.13.0', requestedModel: 'jev-1.13.0', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 0, requestId: undefined };
    },
  };
}

test('the composed notifier waits on the returned ingress inbox and owner veto stops actual gateway checkout', async () => {
  const f = fixture();
  const previous = installJudgmentPort(fixturePort());
  const outward: string[] = [];
  const driver: CheckoutPageDriver = {
    identity: () => ({ sessionId: 'fixture-session', pageId: 'fixture-page' }),
    async verifyTerms() { throw new Error('Owner veto must stop this fixture before quote verification'); },
    async url() { return 'https://www.bestbuy.com/checkout'; },
    async fill() { outward.push('fill'); }, async choose() { outward.push('choose'); },
    async fillSecrets() { outward.push('fill-secrets'); return { filledTargets: [], failedTarget: null }; },
    async submitOrder() { outward.push('submit'); return { url: 'https://www.bestbuy.com/done', orderId: null, verified: false }; },
  };
  f.browser.set({ cardFieldGuard: new CardMaterialRedactor(), driverFor: () => driver, armSubmitApproval: async () => {} });
  try {
    await f.services.ready;
    const card = await f.services.cards.create({ label: 'Fixture-only card', kind: 'virtual', number: '4111111111111111', expiryMonth: 1, expiryYear: 2030, cvv: '123', cardholderName: 'Fixture owner', issuerCapMinorUnits: null });
    expect(f.scopes.every((scope) => JSON.stringify(scope) === JSON.stringify({ scope: 'daemon', medium: 'secure' }))).toBe(true);
    const metadataPath = join(f.root, 'home', '.goodvibes', 'tui', 'control-plane', 'payments-cards.json');
    expect(existsSync(metadataPath)).toBe(true);
    expect(readFileSync(metadataPath, 'utf8')).not.toContain('4111111111111111');
    const identity = { merchantDomain: 'bestbuy.com', item: 'Fixture item' };
    await invoke(f.catalog, 'payments.checkout.approve', { ...identity, amount: '11.00', confirm: true });
    const purchase = await invoke(f.catalog, 'payments.checkout.begin', {
      ...identity, requestId: 'product-owner-veto', requestedMax: '11.00', sessionId: 'fixture-session', pageId: 'fixture-page', checkoutUrl: 'https://www.bestbuy.com/checkout', cardId: card.id,
      requestedLines: [{ label: 'Fixture item', quantity: 1 }], lines: [{ label: 'Fixture item', quantity: '1', unitPrice: '$10.00' }],
      shippingOptions: [{ label: 'Standard', cost: '$0.00' }], cardFields: [{ field: 'number', ref: 'fixture-card' }], placeOrderTarget: 'fixture-submit',
    });
    expect(purchase).toMatchObject({ outcome: 'accepted', purchaseId: 'product-owner-veto' });
    await until(() => f.services.paymentReplies.inspect().length === 1);
    expect(f.services.paymentReplies.pending).toBe(1);
    expect(f.deliveries).toHaveLength(1);
    const selected = f.services.paymentReplies.inspect()[0]; if (!selected) throw new Error('Missing actual operator window');
    expect(await invoke(f.catalog, 'payments.purchase.cancel', { purchaseId: selected.purchaseId, windowId: selected.windowId, confirm: true }))
      .toMatchObject({ accepted: true, answer: 'object' });
    await until(async () => readPaymentWindowStatus(await invoke(f.catalog, 'payments.purchase.status')).operations[0]?.state === 'cancelled');
    const requestRoot = join(f.root, 'home', '.goodvibes', 'tui', 'control-plane', 'payments-requests');
    await until(() => !existsSync(join(requestRoot, `${Buffer.from('product-owner-veto').toString('base64url')}.json`)));
    expect(outward).toEqual([]);
  } finally {
    await f.services.close();
    installJudgmentPort(previous);
  }
});


test('legacy unregister reports cleanup failure while awaited close retains the same rejection', async () => {
  const f = fixture();
  await f.services.ready;
  const warnings: unknown[] = [];
  const warn = spyOn(logger, 'warn').mockImplementation((...args) => { warnings.push(args); });
  const register = spyOn(f.catalog, 'register').mockImplementation(() => { throw new Error('fixture-sensitive-path'); });
  try {
    f.services.unregister();
    await expect(f.services.close()).rejects.toBeInstanceOf(AggregateError);
    await expect(f.services.close()).rejects.toThrow('Payment composition did not close cleanly');
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toContain('fixture-sensitive-path');
    await expect(f.services.paymentReplies.waitForAnswer({ purchaseId: 'fixture-veto', kind: 'veto', channels: ['telegram'], notice: 'fixture', deadlineMs: Date.now() + 1000 })).rejects.toBeInstanceOf(PaymentReplyInboxClosedError);
  } finally {
    register.mockRestore();
    warn.mockRestore();
  }
});


function barrier() {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { pending, release };
}
function journalPath(f: ReturnType<typeof fixture>) {
  return join(f.root, 'home', '.goodvibes', 'tui', 'control-plane', 'payments-checkout-journal.json');
}
function interruptedRecord(phase: InFlightCheckout['phase'], reservationId: string | null): InFlightCheckout {
  const currency = parseCurrencyCode('USD'), item = ownerSuppliedText('Fixture item', 'owner-direct');
  if (!currency || !item) throw new Error('Invalid payment fixture');
  return { purchaseId: 'old-purchase', sessionId: 'old-session', pageId: 'old-page', merchantDomain: 'bestbuy.com', cardId: 'old-card',
    item, currency, phase, startedAtMs: 1, updatedAtMs: 2, draw: null, reservationId,
    shippingTierRequested: 'normal', shippingTierUsed: null, stepDown: null, totalMinorUnits: null };
}

test('real product boot recovery settles a durable pre-submit hold without a browser seam', async () => {
  const f = fixture(); await f.services.ready;
  const held = f.services.budget.reserve({ id: 'old-purchase', itemMinorUnits: 1000, overageMinorUnits: 0, toleranceMinorUnits: 0,
    limits: { dailyItemMinorUnits: 10_000, dailyOverageMinorUnits: 10_000, perPurchaseCeiling: { enabled: false, minorUnits: 0 },
      overageTolerance: { enabled: false, dailyAllowanceMinorUnits: 0 } }, nowMs: Date.now(), timezone: 'UTC', retainUntilSettled: true });
  expect(held).not.toBeNull(); await f.services.close();
  const journal = new DurableCheckoutJournal(journalPath(f)); await journal.put(interruptedRecord('awaiting-window', held!.id));
  const replacement = createPaymentsServices(f.options);
  try {
    await replacement.ready;
    expect(f.browser.get()).toBeUndefined();
    expect(replacement.budget.state().reservations).toEqual([]);
    expect(await new DurableCheckoutJournal(journalPath(f)).list()).toEqual([]);
    expect(f.deliveries).toHaveLength(1);
    expect(JSON.stringify(f.deliveries)).toContain('before anything was submitted');
    for (const id of ATTACHED_PAYMENTS_METHOD_IDS) expect(f.catalog.hasHandler(id)).toBe(true);
  } finally { await replacement.close(); }
});

test.each(['cancel-before-boot', 'original-page-unavailable'] as const)(
  'native product recovery retains the actual lease and hold before readiness, then cleans up %s', async mode => {
    const f = fixture(); await f.services.ready;
    const original = protectedPaymentRequest('native-startup-window'), window = protectedPaymentWindow(original);
    const configuration = readPaymentsServiceConfig({ get: key => f.values[key] });
    const held = f.services.budget.reserve({ id: original.purchaseId, itemMinorUnits: 2_000, overageMinorUnits: 0, toleranceMinorUnits: 0,
      limits: configuration.limits, nowMs: Date.now(), timezone: configuration.timezone, retainUntilSettled: true });
    expect(held).not.toBeNull(); await f.services.close();
    const paired = f.pairing.mint({ name: 'Original recovered checkout owner' }), native = f.pairing.authenticateNative(paired.token);
    if (!native) throw new Error('Missing native pairing');
    const authority = { ...native, scopes: ['write:payments'] }, binding = paymentContinuationBinding(original.operationId);
    const continuation = f.pairing.issueNativeContinuation(paired.token, authority, binding, () => {}, binding);
    const browser = { version: 1 as const, endpoint: 'ws://127.0.0.1:9222/devtools/browser/original', targetId: 'original-target',
      browserContextId: 'original-context', frames: [{ id: 'original-frame', loaderId: 'original-document', parentId: null }] };
    const controls = { version: 1 as const, snapshotId: 'original-local-snapshot', url: original.input.checkoutUrl,
      controls: [original.input.controls.cardFields[0]?.ref, original.input.controls.placeOrderTarget].map((ref, index) => {
        if (!ref) throw new Error('Missing fixture ref');
        return { ref, role: index ? 'button' : 'textbox', name: 'Fixture control', tag: index ? 'button' : 'input', selector: index ? '#order' : '#card',
          depth: 1, submits: !!index, frameChain: [], metadata: { name: 'Fixture control', documentUrl: original.input.checkoutUrl } };
      }) };
    const base = join(f.root, 'home', '.goodvibes', 'tui', 'control-plane');
    const requests = new ProtectedPaymentRequests(join(base, 'payments-requests'));
    await requests.retain({ ...original, principalId: native.principalId, window,
      host: { authority, configuration, continuation, browser, browserControls: controls } }, () => {});
    const operations = new DurablePaymentOperations(join(base, 'payments-operations'));
    const oldWriter = operations.create({ purchaseId: original.purchaseId, operationId: original.operationId, state: 'running', phase: 'awaiting-window',
      createdAtMs: 1, updatedAtMs: 2, outcome: null, currency: 'USD', totalMinorUnits: 2_000 }, native.principalId, () => {});
    oldWriter.release(); await new DurableCheckoutJournal(journalPath(f)).put(window.record);
    let pageReads = 0;
    f.browser.set({ cardFieldGuard: new CardMaterialRedactor(), driverFor: () => { throw new Error('Do not create another browser'); },
      async armSubmitApproval() {}, async capturePageConnection() { return browser; },
      async restoreCheckoutRecovery(facts, owner) { owner.assertCurrent?.(); pageReads++; expect(facts.connection).toEqual(browser); throw new Error('Original native page disappeared'); } });
    const scopes = prepareGatewayScopePolicyOwner(f.catalog, () => {}, true);
    const replacement = createPaymentsServices({ ...f.options, paymentContinuationOwner: { pairing: f.pairing, scopes } });
    try {
      // This must resolve before facade/boot exists. The real execution lease
      // prevents the conservative sweep or a second host from freeing the hold.
      await replacement.ready;
      expect(pageReads).toBe(0); expect(replacement.budget.state().reservations.map(row => row.id)).toEqual([original.purchaseId]);
      expect(operations.recover(original.purchaseId)).toBeNull();
      const status = await invoke(f.catalog, 'payments.purchase.status', {});
      expect(readPaymentWindowStatus(status).operations[0]?.state).toBe('running');
      if (mode === 'original-page-unavailable') {
        completeGatewayScopePolicyBootstrap(f.catalog); completeGatewayScopePolicyBootstrap(f.catalog, 'boot');
        await until(() => operations.get(original.purchaseId)?.state === 'refused'); expect(pageReads).toBe(1);
      }
      await replacement.close();
      expect(replacement.budget.state().reservations).toEqual([]);
      expect(await new DurableCheckoutJournal(journalPath(f)).list()).toEqual([]);
      expect(f.pairing.readNativeContinuation(continuation)).toBeNull();
      expect(existsSync(join(base, 'payments-requests', `${Buffer.from(original.purchaseId).toString('base64url')}.json`))).toBe(false);
      expect(f.deliveries).toEqual([]);
      const writer = operations.recover(original.purchaseId); if (!writer) throw new Error('Original executor lease did not drain'); writer.release();
    } finally { await replacement.close(); scopes.close(); }
  },
);

test('real product close drains boot recovery delivery and cannot stamp a retired recovery', async () => {
  const f = fixture(); await f.services.ready; await f.services.close();
  const journal = new DurableCheckoutJournal(journalPath(f)); await journal.put(interruptedRecord('submit-pending', null));
  const entered = barrier(), gate = barrier();
  f.options.channelDeliveryRouter.deliverWithReceipt = async request => {
    f.deliveries.push(request); entered.release(); await gate.pending;
    return { receipt: { surfaceKind: 'tui', conversationId: 'original-terminal', messageId: 'late-notice' } };
  };
  const replacement = createPaymentsServices(f.options);
  try {
    await entered.pending;
    const closing = replacement.close();
    expect(replacement.close()).toBe(closing);
    let drained = false; void closing.then(() => { drained = true; });
    await Promise.resolve(); await Promise.resolve(); expect(drained).toBe(false);
    for (const id of ATTACHED_PAYMENTS_METHOD_IDS) expect(f.catalog.hasHandler(id)).toBe(false);
    gate.release(); await closing;
    const records = await new DurableCheckoutJournal(journalPath(f)).list();
    expect(records[0]?.phase).toBe('submit-pending'); expect(records[0]?.recoveryNotifiedAtMs).toBeUndefined();
    for (const id of ATTACHED_PAYMENTS_METHOD_IDS) expect(f.catalog.hasHandler(id)).toBe(false);
  } finally { gate.release(); await replacement.close(); }
});

function beginBody(cardId: string) {
  return { requestId: 'product-owned-checkout', merchantDomain: 'bestbuy.com', item: 'Fixture item', requestedMax: '11.00', sessionId: 'fixture-session', pageId: 'fixture-page',
    checkoutUrl: 'https://www.bestbuy.com/checkout', cardId, requestedLines: [{ label: 'Fixture item', quantity: 1 }],
    lines: [{ label: 'Fixture item', quantity: '1', unitPrice: '$10.00' }], shippingOptions: [{ label: 'Standard', cost: '$0.00' }],
    cardFields: [{ field: 'number', ref: 'fixture-card' }], placeOrderTarget: 'fixture-submit' };
}

test.each(['preflight', 'submit'] as const)('actual product close retains an admitted %s operation until it drains', async phase => {
  const f = fixture(), entered = barrier(), gate = barrier();
  const previous = installJudgmentPort(fixturePort()), effects: string[] = [];
  const driver: CheckoutPageDriver = {
    identity: () => ({ sessionId: 'fixture-session', pageId: 'fixture-page' }),
    async verifyTerms(expected, owner) {
      owner.assertCurrent();
      return expected.currency === 'USD' && expected.totalMinorUnits === 1_000 && expected.taxMinorUnits === 0
        && expected.feesMinorUnits === 0 && expected.shippingMinorUnits === 0 && expected.lines.length === 1
        && expected.lines[0]?.label === 'Fixture item' && expected.lines[0]?.quantity === 1;
    },
    async url() { return 'https://www.bestbuy.com/checkout'; }, async fill() { effects.push('fill'); }, async choose() {},
    async fillSecrets(fields) { effects.push('fill-secrets'); return { filledTargets: fields.map(field => field.target), failedTarget: null }; },
    async submitOrder() { effects.push('submit'); entered.release(); await gate.pending; throw new Error('Unknown merchant outcome'); },
  };
  f.browser.set({ cardFieldGuard: new CardMaterialRedactor(), driverFor: () => driver, armSubmitApproval: async () => {} });
  let restoreMetadata: (() => void) | undefined, pending: Promise<Record<string, unknown>> | undefined;
  try {
    await f.services.ready;
    const card = await f.services.cards.create({ label: 'Fixture', kind: 'virtual', number: '4111111111111111', expiryMonth: 1, expiryYear: 2030, cvv: '123', cardholderName: 'Fixture', issuerCapMinorUnits: null });
    await invoke(f.catalog, 'payments.checkout.approve', { merchantDomain: 'bestbuy.com', item: 'Fixture item', amount: '11.00', confirm: true });
    if (phase === 'preflight') {
      const original = f.services.cards.metadata.bind(f.services.cards);
      const metadata = spyOn(f.services.cards, 'metadata').mockImplementation(async id => { entered.release(); await gate.pending; return original(id); });
      restoreMetadata = () => metadata.mockRestore();
    }
    pending = invoke(f.catalog, 'payments.checkout.begin', beginBody(card.id));
    expect(await pending).toMatchObject({ outcome: 'accepted', purchaseId: 'product-owned-checkout' });
    const status = readPaymentWindowStatus(await invoke(f.catalog, 'payments.purchase.status'));
    const operation = status.operations[0]; if (!operation) throw new Error('Missing admitted product operation');
    const requestRoot = join(f.root, 'home', '.goodvibes', 'tui', 'control-plane', 'payments-requests');
    const saved = await new ProtectedPaymentRequests(requestRoot).read('product-owned-checkout', operation.operationId, () => {});
    expect(saved.input.item).toBe('Fixture item'); expect(saved.input.requestedMax).toBe('11.00');
    expect(saved.host.authority.kind).toBe('pairing-token');
    if (!saved.host.continuation) throw new Error('Missing actual product continuation grant');
    expect(f.pairing.readNativeContinuation(saved.host.continuation)).toEqual(saved.host.authority);
    const privatePath = join(requestRoot, `${Buffer.from('product-owned-checkout').toString('base64url')}.json`);
    expect(readFileSync(privatePath, 'utf8')).not.toContain('Fixture item');
    if (phase === 'submit') {
      await until(() => f.services.paymentReplies.inspect().length === 1);
      const selected = f.services.paymentReplies.inspect()[0];
      if (!selected) throw new Error('Expected an actual pending payment window');
      f.services.paymentReplies.answer({ purchaseId: selected.purchaseId, windowId: selected.windowId, action: 'approve' });
    }
    await entered.pending;
    const closing = f.services.close(); let drained = false; void closing.then(() => { drained = true; });
    await Promise.resolve(); await Promise.resolve(); expect(drained).toBe(false);
    for (const id of ATTACHED_PAYMENTS_METHOD_IDS) expect(f.catalog.hasHandler(id)).toBe(false);
    gate.release(); await closing;
    expect(f.pairing.readNativeContinuation(saved.host.continuation)).toBeNull();
    if (phase === 'preflight') {
      expect(effects).toEqual([]); expect(f.services.budget.state().reservations).toEqual([]);
      expect(existsSync(privatePath)).toBe(false);
    }
    else {
      expect(effects).toContain('submit'); expect(f.services.budget.state().reservations[0]?.retainUntilSettled).toBe(true);
      expect((await new DurableCheckoutJournal(journalPath(f)).list())[0]?.phase).toBe('submit-pending');
      expect(existsSync(privatePath)).toBe(true);
    }
  } finally {
    gate.release();
    const closing = f.services.close();
    await Promise.allSettled(pending ? [pending, closing] : [closing]);
    restoreMetadata?.(); installJudgmentPort(previous);
  }
});


function purchasePath(f: ReturnType<typeof fixture>) {
  return join(f.root, 'home', '.goodvibes', 'tui', 'control-plane', 'payments-purchases.json');
}
function recordedSubmission(): PurchaseRecord {
  return { purchaseId: 'old-purchase', atUtc: '2026-11-08T12:00:00.000Z', dayKey: '2026-11-08', timezone: 'UTC',
    merchantDomain: 'bestbuy.com', item: 'Fixture item', currency: 'USD', itemMinorUnits: 1000, taxMinorUnits: 0,
    feesMinorUnits: 0, shippingMinorUnits: 0, totalMinorUnits: 1000, shippingTierRequested: 'normal', shippingTierUsed: 'normal',
    steppedDown: false, itemPoolDraw: 1000, overagePoolDraw: 0, tolerancePoolDraw: 0, cardLast4: '1111', windowKind: 'veto',
    windowOutcome: 'proceeded', answeredBy: null, outcome: 'submitted-unverified', refusalReason: null, merchantOrderId: null,
    refundedAt: null, merchantRecognised: true, merchantQualifier: 'fixture', merchantDiscovered: false };
}

test('actual boot recovery finds the real recorded submission without upgrading unverified to purchased', async () => {
  const f = fixture(); await f.services.ready;
  const record = recordedSubmission();
  const hold = f.services.budget.reserve({ id: record.purchaseId, itemMinorUnits: record.itemPoolDraw, overageMinorUnits: record.overagePoolDraw, toleranceMinorUnits: record.tolerancePoolDraw,
    limits: readPaymentsServiceConfig(f.options.configManager).limits, nowMs: Date.parse(record.atUtc), timezone: 'UTC', retainUntilSettled: true });
  expect(hold).not.toBeNull(); expect(f.services.budget.commit(record.purchaseId, Date.parse(record.atUtc))).not.toBeNull();
  await f.services.purchases.record(record); await f.services.close();
  await new DurableCheckoutJournal(journalPath(f)).put(interruptedRecord('submit-pending', null));
  const replacement = createPaymentsServices(f.options);
  try {
    await replacement.ready;
    expect(await replacement.purchases.has('old-purchase')).toBe(true);
    expect(replacement.purchases.get('old-purchase')?.outcome).toBe('submitted-unverified');
    expect(await new DurableCheckoutJournal(journalPath(f)).list()).toEqual([]);
    expect(JSON.stringify(f.deliveries)).toContain('submission is recorded');
    expect(JSON.stringify(f.deliveries)).not.toContain('the order completed');
    expect(replacement.budget.state().spend).toMatchObject([{ purchaseId: 'old-purchase', itemMinorUnits: 1000 }]);
  } finally { await replacement.close(); }
});

test('a damaged real ledger keeps interrupted evidence and refuses new checkout before browser admission', async () => {
  const f = fixture(); await f.services.ready; await f.services.close();
  const damaged = '{"version":1,"purchases":[{'; mkdirSync(dirname(purchasePath(f)), { recursive: true }); writeFileSync(purchasePath(f), damaged);
  await new DurableCheckoutJournal(journalPath(f)).put(interruptedRecord('submit-pending', null));
  let driverCalls = 0;
  f.browser.set({ cardFieldGuard: new CardMaterialRedactor(), driverFor: () => { driverCalls++; throw new Error('Unexpected browser admission'); }, armSubmitApproval: async () => {} });
  const replacement = createPaymentsServices(f.options);
  try {
    await replacement.ready;
    expect((await new DurableCheckoutJournal(journalPath(f)).list())[0]?.phase).toBe('submit-pending');
    expect(f.deliveries).toEqual([]);
    await expect(invoke(f.catalog, 'payments.purchases.list')).rejects.toMatchObject({ status: 409 });
    await invoke(f.catalog, 'payments.checkout.approve', { merchantDomain: 'bestbuy.com', item: 'Fixture item', amount: '11.00', confirm: true });
    let failure: unknown;
    try { await invoke(f.catalog, 'payments.checkout.begin', beginBody('missing-card')); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ status: 409 }); expect(String(failure)).not.toContain(f.root);
    expect(driverCalls).toBe(0); expect(readFileSync(purchasePath(f), 'utf8')).toBe(damaged);
    expect(() => replacement.budget.state()).toThrow('Payment budget accounting is unavailable');
  } finally { await replacement.close(); }
});
