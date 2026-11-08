import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { BudgetLedger } from '../sdk/src/platform/payments/budget.js';
import { CardMaterialRedactor } from '../sdk/src/platform/payments/card-redaction.js';
import { CheckoutRegistry, MemoryCheckoutJournal } from '../sdk/src/platform/payments/checkout-registry.js';
import { CheckoutOwnershipError } from '../sdk/src/platform/payments/checkout-ownership.js';
import { runCheckout, type CheckoutFlowDeps, type CheckoutControls, type PurchaseRequest } from '../sdk/src/platform/payments/checkout-flow.js';
import { CheckoutSubmitRefused, type CheckoutTerms } from '../sdk/src/platform/payments/checkout-page.js';
import { createChannelPaymentNotifier } from '../sdk/src/platform/payments/notice-delivery.js';
import { PaymentReplyInbox } from '../sdk/src/platform/payments/reply-inbox.js';
import type { RawCheckoutReading } from '../sdk/src/platform/payments/checkout-extraction.js';
import type { PurchaseRecord } from '../sdk/src/platform/payments/purchase-record.js';
import { PaymentsGatewayServiceImpl } from '../sdk/src/platform/payments/payments-gateway-service.js';
import { readPaymentsServiceConfig } from '../sdk/src/platform/payments/payments-config.js';
import { parseCurrencyCode, unsafeOwnerSuppliedTextForTests } from '../sdk/src/platform/payments/types.js';
import { UntrustedContentLedger } from '../sdk/src/platform/security/untrusted-content.js';
import { usePaymentsReadings } from './helpers/payments-readings.ts';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';

const readings = usePaymentsReadings();
const roots: string[] = [];
const owners: (() => void)[] = [], gates: (() => void)[] = [], work: Promise<unknown>[] = [];
afterEach(async () => {
  for (const retire of owners.splice(0)) retire();
  for (const release of gates.splice(0)) release();
  await Promise.allSettled(work.splice(0));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function barrier() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); gates.push(release); return { wait, release }; }
const material = { number: '4242424242424242', expiryMonth: '01', expiryYear: '2030', cvv: '918', cardholderName: 'Fixture Owner' };
function fixture() {
  const currency = parseCurrencyCode('USD'); if (!currency) throw new Error('Fixture currency failed');
  const ledger = new BudgetLedger(), journal = new MemoryCheckoutJournal(), redactor = new CardMaterialRedactor();
  let active = true, page = 'page', metadataFailure = false;
  owners.push(() => { active = false; });
  let onMerchant = async () => {}, onMetadata = async () => {}, onChoose = async () => {}, onSubmit = async () => {};
  let onTerms = async (_expected: CheckoutTerms) => true;
  const terms: CheckoutTerms[] = [];
  const effects: string[] = [], records: PurchaseRecord[] = [], notices: { kind: string; message: string }[] = [];
  let merchantCalls = 0;
  const request: PurchaseRequest = { purchaseId: 'owned-purchase', merchantDomain: 'bestbuy.com', checkoutUrl: 'https://www.bestbuy.com/checkout',
    item: unsafeOwnerSuppliedTextForTests('Original item'), requestedLines: [{ label: 'Original item', quantity: 1 }], cardId: 'card', preferredTier: 'normal' };
  const reading: RawCheckoutReading = { lines: [{ label: 'Original item', quantity: '1', unitPrice: '$10.00' }], tax: '$1.00', fees: [],
    shippingOptions: [{ label: 'Standard', cost: '$0.00' }], statedTotal: '$11.00', currency: 'USD', orderSummaryText: 'One original item' };
  const controls: CheckoutControls = { cardFields: [{ field: 'number', target: 'card-field' }], shippingTargets: ['shipping-original'], placeOrderTarget: 'submit-original' };
  const deps: CheckoutFlowDeps = {
    assertCurrent() { if (!active) throw new Error('Private source diagnostic'); },
    ledger, registry: new CheckoutRegistry(journal), redactor,
    cards: {
      async metadata(id) { effects.push('metadata'); await onMetadata(); if (metadataFailure) throw new Error('Private store diagnostic');
        return { id, label: 'Fixture', brand: 'visa', last4: '4242', kind: 'virtual', expiryMonth: 1, expiryYear: 2030,
          issuerCapMinorUnits: null, addedAt: '2026-11-07T12:00:00Z' }; },
      async read() { effects.push('card-read'); return material; },
    },
    addresses: { async read() { return null; } },
    purchases: { async record(record) { records.push(record); } },
    notifier: {
      async deliver(input) { input.assertCurrent?.(); notices.push({ kind: input.kind, message: input.message }); return [{ channel: 'telegram', delivered: true, backfillable: true }]; },
      async awaitAnswer(input) { return { answer: input.kind === 'approval' ? 'approve' : 'acknowledge', channel: 'operator' }; },
    },
    driver: {
      identity: () => ({ sessionId: 'session', pageId: page }), async url() { return 'https://www.bestbuy.com/checkout'; },
      async verifyTerms(expected, owner) {
        owner.assertCurrent(); terms.push(expected);
        const result = await onTerms(expected); owner.assertCurrent();
        return result && expected.totalMinorUnits === 1_100 && expected.currency === 'USD'
          && expected.lines.length === 1 && expected.lines[0]?.label === 'Original item' && expected.lines[0]?.quantity === 1;
      },
      async fill(target, _value, owner) { owner?.assertCurrent(); effects.push(`fill:${target}`); },
      async fillSecrets(fields, owner) { owner?.assertCurrent(); effects.push(...fields.map(field => `secret:${field.target}`)); return { filledTargets: fields.map(field => field.target), failedTarget: null }; },
      async choose(target, _value, owner) { owner?.assertCurrent(); effects.push(`choose:${target}`); await onChoose(); },
      async submitOrder(target, owner) { owner?.assertCurrent(); effects.push(`submit:${target}`); await onSubmit(); return { url: 'https://www.bestbuy.com/checkout', orderId: 'order', verified: true }; },
    },
    untrusted: new UntrustedContentLedger(),
    limits: { dailyItemMinorUnits: 10_000, dailyOverageMinorUnits: 10_000, perPurchaseCeiling: { enabled: false, minorUnits: 0 }, overageTolerance: { enabled: false, dailyAllowanceMinorUnits: 0 } },
    budgetCurrency: currency, timezone: 'UTC', approvalMinutes: 60, vetoMinutes: 10, now: () => Date.parse('2026-11-07T12:00:00Z'),
    gates: { enabled: true, hasUsableCard: true, hasShippingAddress: true, isOwnerDirectRequest: true, isPaymentsLeader: true },
    merchantJudge: { async judge() { merchantCalls++; await onMerchant(); return { qualifies: true, confident: true, recourse: 'Fixture recourse' }; } },
  };
  return { deps, request, reading, controls, ledger, journal, redactor, effects, records, notices, terms,
    run: () => { const pending = runCheckout(request, reading, controls, deps); work.push(pending); drainOwned(pending); return pending; },
    revoke: () => { active = false; }, changePage: () => { page = 'replacement-page'; },
    merchantCalls: () => merchantCalls, failMetadata: () => { metadataFailure = true; },
    onMerchant: (work: () => Promise<void>) => { onMerchant = work; }, onMetadata: (work: () => Promise<void>) => { onMetadata = work; },
    onChoose: (work: () => Promise<void>) => { onChoose = work; }, onSubmit: (work: () => Promise<void>) => { onSubmit = work; },
    onTerms: (work: (expected: CheckoutTerms) => Promise<boolean>) => { onTerms = work; } };
}

test.each(['before-card', 'before-submit'] as const)('changed checkout terms %s release the hold and never submit', async phase => {
  const f = fixture(); let calls = 0;
  f.onTerms(async expected => { calls++; expect(expected.totalMinorUnits).toBe(1_100); return phase === 'before-submit' && calls === 1; });
  const result = await f.run();
  expect(result).toMatchObject({ kind: 'refused', code: 'total-changed' });
  expect(f.effects.some(effect => effect.startsWith('submit:'))).toBe(false); expect(f.records).toEqual([]);
  expect(f.ledger.state().reservations).toEqual([]); expect(await f.journal.list()).toEqual([]);
  if (phase === 'before-card') expect(f.effects).not.toContain('card-read');
  else { expect(f.effects).toContain('card-read'); expect(f.redactor.hasLiveMaterial('session', 'page')).toBe(true); }
});

test('fresh quote capability cannot be replaced while the approval window is pending', async () => {
  const f = fixture(), entered = barrier(), wait = barrier();
  f.deps.notifier.awaitAnswer = async () => { entered.release(); await wait.wait; return { answer: 'acknowledge', channel: 'operator' }; };
  const result = f.run().catch((error: unknown) => error);
  try {
    await entered.wait;
    f.deps.driver.verifyTerms = async () => true;
    wait.release(); expect(await result).toBeInstanceOf(CheckoutOwnershipError);
    expect(f.effects).not.toContain('card-read'); expect(f.records).toEqual([]);
    expect(f.ledger.state().reservations).toEqual([]); expect(await f.journal.list()).toEqual([]);
  } finally { wait.release(); await result; }
});

test('an unavailable fresh quote reader cannot release the window into a purchase', async () => {
  const f = fixture(); f.onTerms(async () => { throw new Error('Fresh page unavailable'); });
  await expect(f.run()).rejects.toThrow('Fresh page unavailable');
  expect(f.effects).not.toContain('card-read'); expect(f.records).toEqual([]);
  expect(f.ledger.state().reservations).toEqual([]); expect(await f.journal.list()).toEqual([]);
});

test('a driver without a fresh quote reader refuses before taking money or asking a model', async () => {
  const f = fixture(); Reflect.deleteProperty(f.deps.driver, 'verifyTerms');
  expect(await f.run()).toMatchObject({ kind: 'refused', code: 'total-changed' });
  expect(f.effects).toEqual([]); expect(readings.requests).toEqual([]);
  expect(f.ledger.state().reservations).toEqual([]); expect(await f.journal.list()).toEqual([]);
});

test('a checkout retains the original complete request, page reading and controls through a suspended merchant read', async () => {
  const f = fixture(), entered = barrier(), gate = barrier();
  f.onMerchant(async () => { entered.release(); await gate.wait; });
  const pending = f.run(); await entered.wait;
  Reflect.set(f.request, 'item', unsafeOwnerSuppliedTextForTests('Replacement item'));
  Reflect.set(f.reading.lines[0]!, 'unitPrice', '$999.00');
  Reflect.set(f.controls, 'placeOrderTarget', 'submit-replacement');
  gate.release(); const outcome = await pending;
  expect(outcome.kind).toBe('purchased'); expect(f.records[0]?.item).toBe('Original item');
  expect(f.records[0]?.totalMinorUnits).toBe(1_100);
  expect(f.effects).toContain('submit:submit-original'); expect(f.effects).not.toContain('submit:submit-replacement');
  expect(JSON.stringify([f.notices, f.records, readings.requests])).not.toContain(material.number);
});

test.each(['owner', 'page', 'replaced-guard'] as const)('%s retirement during a merchant read prevents every downstream effect', async kind => {
  const f = fixture(), entered = barrier(), gate = barrier();
  f.onMerchant(async () => { entered.release(); await gate.wait; });
  const pending = f.run(); const handled = pending.catch(error => error); await entered.wait;
  if (kind === 'page') f.changePage();
  else { f.revoke(); if (kind === 'replaced-guard') Reflect.set(f.deps, 'assertCurrent', () => {}); }
  gate.release(); expect(await handled).toBeInstanceOf(CheckoutOwnershipError);
  expect(f.effects).toEqual([]); expect(f.ledger.state().reservations).toEqual([]); expect(await f.journal.list()).toEqual([]);
});

test('metadata failure after reservation releases the known pre-submit hold and closes its journal', async () => {
  const f = fixture(); f.failMetadata();
  await expect(f.run()).rejects.toThrow('Private store diagnostic');
  expect(f.ledger.state().reservations).toEqual([]); expect(await f.journal.list()).toEqual([]);
  expect(f.effects).toEqual(['metadata']); expect(f.notices).toEqual([]);
});

test.each([
  ['approval', 'yes', 'approve', 'purchased'],
  ['approval', 'no', 'deny', 'refused'],
  ['veto', 'yes', 'acknowledge', 'purchased'],
  ['veto', 'stop', 'object', 'cancelled'],
] as const)('actual %s checkout owns an early %s reply until its window flush completes', async (kind, reply, answer, outcome) => {
  const f = fixture(), sending = barrier(), delivered = barrier(), flushing = barrier(), durable = barrier();
  const replies = new PaymentReplyInbox({ now: () => f.deps.now?.() ?? Date.now() });
  Reflect.set(f.deps, 'merchantJudge', { async judge() { return { qualifies: kind === 'veto', confident: true, recourse: 'Fixture recourse' }; } });
  Reflect.set(f.deps, 'notifier', createChannelPaymentNotifier({ replies,
    targets: [{ channel: 'telegram', request: {}, backfillable: false }],
    router: { async deliver() { sending.release(); await delivered.wait; return 'actual-notice'; } },
  }));
  const put = f.journal.put.bind(f.journal);
  f.journal.put = async record => {
    if (record.windowDeliveries) { flushing.release(); await durable.wait; }
    await put(record);
  };
  const purchase = f.run();
  try {
    await sending.wait;
    expect(replies.pending).toBe(1); expect(replies.inspect()).toEqual([]);
    let consumed = false;
    const offer = replies.offer('telegram', reply);
    void offer.then(() => { consumed = true; });
    await Promise.resolve(); delivered.release(); await flushing.wait;
    expect(consumed).toBe(false); expect(replies.inspect()).toEqual([]);
    expect(readings.requests.filter(request => request.context?.site === 'payments.reply')).toEqual([]);
    expect(f.effects).toEqual(['metadata']); expect(f.records).toEqual([]);
    durable.release();
    expect(await offer).toEqual({ consumed: true, answer });
    expect((await purchase).kind).toBe(outcome);
    if (outcome === 'purchased') { expect(f.records).toHaveLength(1); expect(f.effects).toContain('submit:submit-original'); }
    else { expect(f.effects).toEqual(['metadata']); expect(f.records).toEqual([]); }
    expect(f.ledger.state().reservations).toEqual([]); expect(await f.journal.list()).toEqual([]);
    expect(replies.pending).toBe(0);
  } finally { delivered.release(); durable.release(); await replies.close(); }
});

test('an actual window flush failure retires its queued reply without interpreting or submitting it', async () => {
  const f = fixture(), sending = barrier(), delivered = barrier();
  const replies = new PaymentReplyInbox({ now: () => f.deps.now?.() ?? Date.now() });
  Reflect.set(f.deps, 'notifier', createChannelPaymentNotifier({ replies,
    targets: [{ channel: 'telegram', request: {}, backfillable: false }],
    router: { async deliver() { sending.release(); await delivered.wait; return 'actual-notice'; } },
  }));
  const put = f.journal.put.bind(f.journal);
  f.journal.put = async record => { if (record.windowDeliveries) throw new Error('Window flush failed'); await put(record); };
  const purchase = f.run();
  try {
    await sending.wait;
    const offer = replies.offer('telegram', 'stop'); await Promise.resolve(); delivered.release();
    await expect(purchase).rejects.toThrow('Window flush failed');
    expect(await offer).toEqual({ consumed: false, reason: 'no-window' });
    expect(readings.requests.filter(request => request.context?.site === 'payments.reply')).toEqual([]);
    expect(f.effects).toEqual(['metadata']); expect(f.records).toEqual([]);
    expect(f.ledger.state().reservations).toEqual([]); expect(await f.journal.list()).toEqual([]);
    expect(replies.pending).toBe(0);
  } finally { delivered.release(); await replies.close(); }
});

test('retirement during a shipping action cannot enter card material or submit', async () => {
  const f = fixture(), entered = barrier(), gate = barrier();
  f.onChoose(async () => { entered.release(); await gate.wait; });
  const pending = f.run(); await entered.wait; f.revoke(); gate.release();
  expect((await pending).kind).toBe('refused');
  expect(f.effects).not.toContain('card-read'); expect(f.effects.some(effect => effect.startsWith('submit:'))).toBe(false);
  expect(f.ledger.state().reservations).toEqual([]); expect(await f.journal.list()).toEqual([]);
});

test('an async ownership assertion is drained and refused before any model or page call', async () => {
  const f = fixture(); Reflect.set(f.deps, 'assertCurrent', async () => { throw new Error('Private async guard'); });
  await expect(f.run()).rejects.toBeInstanceOf(CheckoutOwnershipError);
  expect(f.effects).toEqual([]); expect(readings.requests).toEqual([]);
});

test('an uncertain submit keeps its protected budget and redaction after the owner retires', async () => {
  const f = fixture(); f.onSubmit(async () => { f.revoke(); throw new Error('No merchant acknowledgement'); });
  const result = await f.run();
  expect(result).toMatchObject({ kind: 'refused', code: 'challenge-abandoned' });
  expect(f.ledger.state().reservations[0]?.retainUntilSettled).toBe(true);
  expect((await f.journal.list())[0]?.phase).toBe('submit-pending');
  expect(f.redactor.hasLiveMaterial('session', 'page')).toBe(true); expect(f.records).toEqual([]);
});

test('a known completed submit still records accounting after retirement, without sending a new report', async () => {
  const f = fixture(); f.onSubmit(async () => { f.revoke(); });
  expect((await f.run()).kind).toBe('purchased');
  expect(f.ledger.state().spend).toHaveLength(1); expect(f.ledger.state().reservations).toEqual([]);
  expect(f.records).toHaveLength(1); expect(await f.journal.list()).toEqual([]); expect(f.notices).toHaveLength(1);
  expect(f.redactor.hasLiveMaterial('session', 'page')).toBe(true);
});

test('a declared pre-click refusal releases the hold while retaining redaction for the filled page', async () => {
  const f = fixture(); f.onSubmit(async () => { throw new CheckoutSubmitRefused('The native actuator was not entered'); });
  expect(await f.run()).toMatchObject({ kind: 'refused', code: 'submit-not-attempted' });
  expect(f.ledger.state().reservations).toEqual([]); expect(await f.journal.list()).toEqual([]);
  expect(f.redactor.hasLiveMaterial('session', 'page')).toBe(true);
});

test.each(['payments.majorRetailersAdditional', 'payments.majorRetailersExcluded'] as const)('%s reaches the real service and controls its window', async key => {
  const root = mkdtempSync(join(tmpdir(), 'checkout-owner-settings-')); roots.push(root);
  const config = new ConfigManager({ configDir: root, homeDir: root, workingDir: root, surfaceRoot: 'daemon' });
  config.setDynamic('payments.budget.dailyItem', 100); config.setDynamic('payments.budget.dailyOverage', 100);
  config.setDynamic('payments.budget.perPurchaseCeilingEnabled', false); config.setDynamic(key, 'bestbuy.com');
  const f = fixture(); const { deps } = f;
  const service = new PaymentsGatewayServiceImpl({ ...deps, journal: f.journal,
    config: () => readPaymentsServiceConfig({ get: name => config.get(name as never) }), gates: () => deps.gates,
    driverFor: () => deps.driver, cardFieldGuard: f.redactor });
  const outcome = await service.beginCheckout({ sessionId: 'session', pageId: 'page', merchantDomain: f.request.merchantDomain,
    checkoutUrl: f.request.checkoutUrl, item: f.request.item, cardId: f.request.cardId, requestedLines: f.request.requestedLines, reading: f.reading,
    controls: { cardFields: f.controls.cardFields.map(field => ({ field: field.field, ref: field.target })),
      shippingTargets: f.controls.shippingTargets, placeOrderTarget: f.controls.placeOrderTarget } });
  expect(outcome.outcome).toBe('purchased'); expect(f.merchantCalls()).toBe(0);
  expect(f.notices[0]?.kind).toBe(key.endsWith('Additional') ? 'veto' : 'approval');
});


function serviceFixture(f: ReturnType<typeof fixture>) {
  const { deps } = f;
  const service = new PaymentsGatewayServiceImpl({ ...deps, journal: f.journal,
    config: () => ({ limits: deps.limits, budgetCurrency: deps.budgetCurrency, timezone: deps.timezone,
      preferredTier: 'normal', approvalMinutes: deps.approvalMinutes, vetoMinutes: deps.vetoMinutes }),
    gates: () => deps.gates, driverFor: () => deps.driver, cardFieldGuard: f.redactor });
  const input = { sessionId: 'session', pageId: 'page', merchantDomain: f.request.merchantDomain,
    checkoutUrl: f.request.checkoutUrl, item: f.request.item, cardId: f.request.cardId,
    requestedLines: f.request.requestedLines, reading: f.reading,
    controls: { cardFields: f.controls.cardFields.map(field => ({ field: field.field, ref: field.target })),
      shippingTargets: f.controls.shippingTargets, placeOrderTarget: f.controls.placeOrderTarget } };
  return { service, input };
}

test.each(['merchant', 'choose', 'submit'] as const)('service shutdown drains an admitted %s call which ignores cancellation', async phase => {
  const f = fixture(), { service, input } = serviceFixture(f), entered = barrier(), gate = barrier();
  const suspended = async () => { entered.release(); await gate.wait; if (phase === 'submit') throw new Error('Unknown merchant result'); };
  if (phase === 'merchant') f.onMerchant(suspended);
  else if (phase === 'choose') f.onChoose(suspended);
  else f.onSubmit(suspended);
  const pending = service.beginCheckout(input), handled = pending.catch(error => error);
  work.push(pending);
  await entered.wait;
  const closing = service.close(); work.push(closing);
  expect(service.close()).toBe(closing);
  let drained = false; void closing.then(() => { drained = true; });
  await Promise.resolve(); await Promise.resolve();
  expect(drained).toBe(false);
  await expect(service.beginCheckout(input)).rejects.toBeInstanceOf(CheckoutOwnershipError);
  gate.release(); await handled; await closing;
  if (phase === 'submit') {
    expect(f.ledger.state().reservations[0]?.retainUntilSettled).toBe(true);
    expect((await f.journal.list())[0]?.phase).toBe('submit-pending');
    expect(f.records).toEqual([]);
  } else {
    expect(f.effects.some(effect => effect.startsWith('submit:'))).toBe(false);
    expect(f.ledger.state().reservations).toEqual([]);
    expect(await f.journal.list()).toEqual([]);
  }
});

test('service close is published before an abort listener can reenter close', async () => {
  const f = fixture(), { service, input } = serviceFixture(f), entered = barrier(), gate = barrier();
  let reentered: Promise<void> | undefined;
  const original = f.deps.driver.choose;
  f.deps.driver.choose = async (...args) => {
    args[2]?.signal?.addEventListener('abort', () => { reentered = service.close(); }, { once: true });
    entered.release(); await gate.wait; await original(...args);
  };
  const pending = service.beginCheckout(input), handled = pending.catch(error => error); work.push(pending);
  await entered.wait;
  const closing = service.close(); work.push(closing);
  expect(reentered).toBe(closing);
  gate.release(); await handled; await closing;
});


test('explicit host gate facts reach the service instead of its default gate reader', async () => {
  const f = fixture(), { service, input } = serviceFixture(f);
  try {
    const result = await service.beginCheckout(input, { gates: { ...f.deps.gates, enabled: false } });
    expect(result.outcome.startsWith('refused')).toBe(true);
    expect(readings.requests).toEqual([]); expect(f.effects).toEqual([]);
  } finally { await service.close(); }
});


test('unavailable purchase evidence refuses before any judgment or page effect', async () => {
  const f = fixture(); f.deps.purchases.assertAvailable = () => { throw new Error('Private damaged purchase path'); };
  await expect(f.run()).rejects.toBeInstanceOf(CheckoutOwnershipError);
  expect(f.effects).toEqual([]); expect(readings.requests).toEqual([]);
  expect(await f.journal.list()).toEqual([]); expect(f.ledger.state().reservations).toEqual([]);
});

test('retired purchase evidence after shipping cannot type a card or bypass its captured reader', async () => {
  const f = fixture(); let available = true;
  f.deps.purchases.assertAvailable = () => { if (!available) throw new Error('Private damaged purchase path'); };
  f.onChoose(async () => { available = false; f.deps.purchases.assertAvailable = () => {}; });
  await expect(f.run()).rejects.toBeInstanceOf(CheckoutOwnershipError);
  expect(f.effects).not.toContain('card-read'); expect(f.effects.some(effect => effect.startsWith('submit:'))).toBe(false);
  expect(f.ledger.state().reservations).toEqual([]); expect(await f.journal.list()).toEqual([]);
});

test('the submit driver receives the original purchase-evidence fence immediately before its click', async () => {
  const f = fixture(); let available = true;
  f.deps.purchases.assertAvailable = () => { if (!available) throw new Error('Private damaged purchase path'); };
  f.deps.driver.submitOrder = async (_target, owner) => {
    await Promise.resolve(); available = false;
    try { owner?.assertCurrent(); } catch { throw new CheckoutSubmitRefused('Purchase evidence unavailable before click'); }
    f.effects.push('unexpected-click');
    return { url: 'https://www.bestbuy.com/done', orderId: 'unexpected', verified: true };
  };
  expect(await f.run()).toMatchObject({ kind: 'refused', code: 'submit-not-attempted' });
  expect(f.effects).not.toContain('unexpected-click'); expect(f.records).toEqual([]);
  expect(f.ledger.state().reservations).toEqual([]); expect(await f.journal.list()).toEqual([]);
  expect(f.redactor.hasLiveMaterial('session', 'page')).toBe(true);
});


test('the actual service drains an async purchase-evidence guard and refuses before browser setup', async () => {
  const f = fixture(); f.deps.purchases.assertAvailable = async () => { throw new Error('Private async ledger guard'); };
  const { service, input } = serviceFixture(f);
  try {
    await expect(service.beginCheckout(input)).rejects.toBeInstanceOf(CheckoutOwnershipError);
    expect(f.effects).toEqual([]); expect(readings.requests).toEqual([]);
  } finally { await service.close(); }
});
