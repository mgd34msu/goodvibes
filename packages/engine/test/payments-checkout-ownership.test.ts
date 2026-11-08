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
import { CheckoutQuoteChanged, CheckoutSubmitRefused, type CheckoutTerms } from '../sdk/src/platform/payments/checkout-page.js';
import { createChannelPaymentNotifier } from '../sdk/src/platform/payments/notice-delivery.js';
import { PaymentReplyInbox, PaymentReplyWindowError } from '../sdk/src/platform/payments/reply-inbox.js';
import type { RawCheckoutReading } from '../sdk/src/platform/payments/checkout-extraction.js';
import type { PurchaseRecord } from '../sdk/src/platform/payments/purchase-record.js';
import { PaymentsGatewayServiceImpl } from '../sdk/src/platform/payments/payments-gateway-service.js';
import { readPaymentsServiceConfig } from '../sdk/src/platform/payments/payments-config.js';
import { parseCurrencyCode, unsafeOwnerSuppliedTextForTests } from '../sdk/src/platform/payments/types.js';
import { UntrustedContentLedger } from '../sdk/src/platform/security/untrusted-content.js';
import { usePaymentsReadings } from './helpers/payments-readings.ts';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { withExecutionMode } from '../sdk/src/platform/gate/execution-context.js';

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
  let active = true, page = 'page', metadataFailure = false, liveTotal = 1_100;
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
        return result && expected.totalMinorUnits === liveTotal && expected.currency === 'USD'
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
    setLiveTotal: (total: number) => { liveTotal = total; },
    onMerchant: (work: () => Promise<void>) => { onMerchant = work; }, onMetadata: (work: () => Promise<void>) => { onMetadata = work; },
    onChoose: (work: () => Promise<void>) => { onChoose = work; }, onSubmit: (work: () => Promise<void>) => { onSubmit = work; },
    onTerms: (work: (expected: CheckoutTerms) => Promise<boolean>) => { onTerms = work; } };
}

for (const mode of ['safe-owner', 'safe-jev', 'yolo'] as const)
  for (const answer of ['approve', 'deny', 'silence', 'undeliverable'] as const)
    test(`owner maximum remains an explicit approval boundary in ${mode}: ${answer}`, async () => {
      const f = fixture(); Reflect.set(f.request, 'requestedMax', '10.00');
      let questions = 0;
      if (answer === 'undeliverable') f.deps.notifier.deliver = async input => {
        f.notices.push({ kind: input.kind, message: input.message });
        return [{ channel: 'telegram', delivered: false, backfillable: false }];
      };
      f.deps.notifier.awaitAnswer = async input => {
        questions++; expect(input.kind).toBe('approval');
        expect(f.effects).not.toContain('card-read'); expect(f.records).toEqual([]);
        return answer === 'silence' ? null : { answer: answer === 'approve' ? 'approve' : 'deny', channel: 'operator' };
      };
      const outcome = await withExecutionMode(mode, () => f.run());
      expect(f.notices).toHaveLength(1); expect(f.notices[0]?.kind).toBe('approval');
      expect(f.notices[0]?.message).toContain('full total exceeds your requested maximum');
      expect(f.notices[0]?.message).toContain('Requested maximum: USD 10.00');
      expect(f.notices[0]?.message).not.toContain('remaining daily item budget');
      expect(questions).toBe(answer === 'undeliverable' ? 0 : 1);
      if (answer === 'approve') {
        expect(outcome.kind).toBe('purchased');
        expect(f.records).toMatchObject([{ totalMinorUnits: 1_100, requestedMaximumMinorUnits: 1_000, windowKind: 'approval', answeredBy: 'operator' }]);
        expect(f.effects.filter(effect => effect.startsWith('submit:'))).toEqual(['submit:submit-original']);
      } else {
        expect(outcome).toMatchObject({ kind: 'refused', code: `requested-maximum-exceeded-${answer === 'silence' ? 'expired' : answer === 'undeliverable' ? 'undeliverable' : 'denied'}` });
        expect(f.effects).not.toContain('card-read'); expect(f.records).toEqual([]);
        expect(f.effects.some(effect => effect.startsWith('submit:'))).toBe(false);
      }
      expect(f.ledger.state().reservations).toEqual([]); expect(await f.journal.list()).toEqual([]);
    });

test.each(['', 'up to 20 dollars', '-1', '10 20', '10+20', '1e3', '20.001'])('invalid owner maximum %s stops before model, card or notice work', async maximum => {
  const f = fixture(); Reflect.set(f.request, 'requestedMax', maximum);
  expect(await f.run()).toMatchObject({ kind: 'refused', code: 'invalid-requested-maximum' });
  expect(readings.requests).toEqual([]); expect(f.effects).toEqual([]); expect(f.notices).toEqual([]);
  expect(f.ledger.state().reservations).toEqual([]); expect(await f.journal.list()).toEqual([]);
});

test.each(['11.00', '12.00'])('within owner maximum %s keeps the veto window', async maximum => {
  const f = fixture(); Reflect.set(f.request, 'requestedMax', maximum);
  expect((await f.run()).kind).toBe('purchased'); expect(f.notices[0]?.kind).toBe('veto');
  expect(f.records[0]?.requestedMaximumMinorUnits).toBe(maximum === '11.00' ? 1_100 : 1_200);
});

test('caller mutation cannot raise the retained owner maximum during a merchant reading', async () => {
  const f = fixture(), entered = barrier(), resume = barrier(); Reflect.set(f.request, 'requestedMax', '10.00');
  f.onMerchant(async () => { entered.release(); await resume.wait; });
  f.deps.notifier.awaitAnswer = async input => { expect(input.kind).toBe('approval'); return { answer: 'deny', channel: 'operator' }; };
  const pending = f.run();
  try {
    await entered.wait; Reflect.set(f.request, 'requestedMax', '999.00'); resume.release();
    expect(await pending).toMatchObject({ kind: 'refused', code: 'requested-maximum-exceeded-denied' });
    expect(f.notices[0]?.message).toContain('Requested maximum: USD 10.00'); expect(f.effects).not.toContain('card-read');
  } finally { resume.release(); await pending; }
});

test.each(['approve', 'deny'] as const)('repricing across the original request maximum needs a new approval: %s', async answer => {
  const f = fixture(); Reflect.set(f.request, 'requestedMax', '15.00');
  f.deps.driver.readCurrentQuote = async () => ({ ...f.reading,
    lines: [{ label: 'Original item', quantity: '1', unitPrice: '$20.00' }], tax: '$2.00', statedTotal: '$22.00' });
  let windows = 0;
  f.deps.notifier.awaitAnswer = async input => {
    if (++windows === 1) { expect(input.kind).toBe('veto'); f.setLiveTotal(2_200); return { answer: 'acknowledge', channel: 'operator' }; }
    expect(windows).toBe(2); expect(input.kind).toBe('approval');
    expect(f.ledger.snapshot(f.deps.limits, f.deps.now(), 'UTC').item.remaining).toBeGreaterThan(0);
    expect(f.effects).not.toContain('card-read');
    return { answer, channel: 'operator' };
  };
  const result = await f.run();
  expect(f.notices.map(notice => notice.kind)).toEqual(['veto', 'approval']);
  expect(f.notices[1]?.message).toContain('Requested maximum: USD 15.00');
  expect(f.notices[1]?.message).toContain('full total exceeds your requested maximum');
  expect(f.notices[1]?.message).not.toContain('remaining daily item budget');
  if (answer === 'approve') {
    expect(result.kind).toBe('purchased'); expect(f.records).toMatchObject([{ totalMinorUnits: 2_200, requestedMaximumMinorUnits: 1_500 }]);
  } else { expect(result).toMatchObject({ kind: 'refused', code: 'requested-maximum-exceeded-denied' }); expect(f.records).toEqual([]); }
  expect(f.ledger.state().reservations).toEqual([]); expect(await f.journal.list()).toEqual([]);
});

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

test('the checkout service rejects an invalid requested maximum before looking up its browser driver', async () => {
  const f = fixture(), deps = f.deps;
  const input = { sessionId: 'session', pageId: 'page', merchantDomain: f.request.merchantDomain,
    checkoutUrl: f.request.checkoutUrl, item: f.request.item, cardId: f.request.cardId,
    requestedLines: f.request.requestedLines, reading: f.reading,
    controls: { cardFields: f.controls.cardFields.map(field => ({ field: field.field, ref: field.target })),
      shippingTargets: f.controls.shippingTargets, placeOrderTarget: f.controls.placeOrderTarget } };
  const service = new PaymentsGatewayServiceImpl({ ...deps, journal: f.journal,
    config: () => ({ limits: deps.limits, budgetCurrency: deps.budgetCurrency, timezone: deps.timezone,
      preferredTier: 'normal', approvalMinutes: deps.approvalMinutes, vetoMinutes: deps.vetoMinutes }),
    gates: () => deps.gates, driverFor: () => { throw new Error('Invalid limit reached browser setup'); }, cardFieldGuard: f.redactor });
  try {
    expect(await service.beginCheckout({ ...input, requestedMax: '10+20' })).toMatchObject({ outcome: 'refused' });
    expect(f.effects).toEqual([]); expect(readings.requests).toEqual([]); expect(f.notices).toEqual([]);
  } finally { await service.close(); }
});

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

for (const phase of ['before-card', 'after-card', 'before-dispatch'] as const)
  for (const answer of ['approve', 'deny'] as const)
    test(`a new price ${phase} releases the old hold and requires a new budget approval (${answer})`, async () => {
      const f = fixture(), secondWindow = barrier(), answered = barrier();
      Reflect.set(f.deps, 'limits', { ...f.deps.limits, dailyItemMinorUnits: 1_500 });
      const replacement: RawCheckoutReading = { ...f.reading,
        lines: [{ label: 'Original item', quantity: '1', unitPrice: '$20.00' }], tax: '$2.00', statedTotal: '$22.00' };
      let windows = 0, rereads = 0;
      f.deps.driver.readCurrentQuote = async (original, owner) => {
        owner.assertCurrent(); rereads++;
        expect(original.terms.totalMinorUnits).toBe(1_100);
        expect(f.ledger.state().reservations).toEqual([]); expect(await f.journal.list()).toEqual([]);
        expect(f.effects.filter(effect => effect.startsWith('submit:'))).toEqual([]);
        return replacement;
      };
      f.deps.notifier.awaitAnswer = async input => {
        windows++;
        if (windows === 1) {
          expect(input.kind).toBe('veto');
          if (phase === 'before-card') f.setLiveTotal(2_200);
          return { answer: 'acknowledge', channel: 'operator' };
        }
        expect(windows).toBe(2); expect(input.kind).toBe('approval');
        secondWindow.release(); await answered.wait;
        return { answer, channel: 'operator' };
      };
      if (phase === 'after-card') {
        const fill = f.deps.driver.fillSecrets.bind(f.deps.driver); let changed = false;
        f.deps.driver.fillSecrets = async (fields, owner) => {
          const result = await fill(fields, owner);
          if (!changed) { changed = true; f.setLiveTotal(2_200); }
          return result;
        };
      }
      if (phase === 'before-dispatch') {
        const submit = f.deps.driver.submitOrder.bind(f.deps.driver); let changed = false;
        f.deps.driver.submitOrder = async (target, owner) => {
          if (!changed) { changed = true; f.setLiveTotal(2_200); throw new CheckoutQuoteChanged(); }
          return submit(target, owner);
        };
      }
      const result = f.run();
      try {
        await secondWindow.wait;
        expect(rereads).toBe(1); expect(f.notices.map(notice => notice.kind)).toEqual(['veto', 'approval']);
        expect(f.notices[0]?.message).toContain('11.00'); expect(f.notices[1]?.message).toContain('22.00');
        expect(f.records).toEqual([]); expect(f.effects.some(effect => effect.startsWith('submit:'))).toBe(false);
        expect(f.ledger.state().reservations).toMatchObject([{ itemMinorUnits: 2_000, overageMinorUnits: 200 }]);
        if (phase === 'before-card') expect(f.effects).not.toContain('card-read');
        else expect(f.redactor.hasLiveMaterial('session', 'page')).toBe(true);
        answered.release();
        const outcome = await result;
        if (answer === 'approve') {
          expect(outcome.kind).toBe('purchased'); expect(f.records).toMatchObject([{ totalMinorUnits: 2_200 }]);
          expect(f.effects.filter(effect => effect === 'submit:submit-original')).toHaveLength(1);
        } else { expect(outcome.kind).toBe('refused'); expect(f.records).toEqual([]); }
        expect(windows).toBe(2); expect(f.ledger.state().reservations).toEqual([]); expect(await f.journal.list()).toEqual([]);
      } finally { answered.release(); await result; }
    });

test('uncertain submit never invokes repricing or releases its protected original hold', async () => {
  const f = fixture(); let rereads = 0;
  f.deps.driver.readCurrentQuote = async () => { rereads++; return null; };
  f.deps.driver.submitOrder = async () => { throw new Error('The merchant may already have received the click'); };
  expect(await f.run()).toMatchObject({ kind: 'refused', code: 'challenge-abandoned' });
  expect(rereads).toBe(0); expect(f.notices).toHaveLength(1);
  expect(f.ledger.state().reservations).toHaveLength(1);
  expect(await f.journal.list()).toMatchObject([{ phase: 'submit-pending' }]);
});

test('a failed quote check without a verified changed price cannot keep renewing owner windows', async () => {
  const f = fixture(); f.onTerms(async () => false);
  f.deps.driver.readCurrentQuote = async () => f.reading;
  expect(await f.run()).toMatchObject({ kind: 'refused', code: 'total-changed' });
  expect(f.notices).toHaveLength(1); expect(f.effects).not.toContain('card-read');
  expect(f.ledger.state().reservations).toEqual([]); expect(await f.journal.list()).toEqual([]);
});

test('repricing retains the original page even after releasing the earlier quote reservation', async () => {
  const f = fixture(); f.onTerms(async () => false);
  f.deps.driver.readCurrentQuote = async () => {
    f.changePage();
    return { ...f.reading, lines: [{ label: 'Original item', quantity: '1', unitPrice: '$20.00' }], tax: '$2.00', statedTotal: '$22.00' };
  };
  await expect(f.run()).rejects.toBeInstanceOf(CheckoutOwnershipError);
  expect(f.notices).toHaveLength(1); expect(f.effects).not.toContain('card-read');
  expect(f.ledger.state().reservations).toEqual([]); expect(await f.journal.list()).toEqual([]);
});

test('actual operator window IDs change on repricing and an old approval cannot settle the new price', async () => {
  const f = fixture(), first = barrier(), second = barrier(), windows: ReturnType<PaymentReplyInbox['inspect']>[number][] = [];
  Reflect.set(f.request, 'requestedMax', '15.00');
  const replies = new PaymentReplyInbox({ now: () => f.deps.now() });
  const replacement: RawCheckoutReading = { ...f.reading,
    lines: [{ label: 'Original item', quantity: '1', unitPrice: '$20.00' }], tax: '$2.00', statedTotal: '$22.00' };
  f.deps.driver.readCurrentQuote = async () => replacement;
  let deliveries = 0;
  const channel = createChannelPaymentNotifier({ replies, targets: [{ channel: 'telegram', request: {}, backfillable: false }],
    router: { async deliver() { return `actual-quote-notice-${++deliveries}`; } } });
  Reflect.set(f.deps, 'notifier', { ...channel, prepareWindow(input: Parameters<NonNullable<typeof channel.prepareWindow>>[0]) {
    const reception = channel.prepareWindow?.(input); if (!reception) throw new Error('Missing real prepared notice reception');
    return { ...reception, awaitAnswer(deadlineMs: number) {
      const answer = reception.awaitAnswer(deadlineMs), current = replies.inspect()[0];
      if (!current) throw new Error('Missing actual armed operator window');
      windows.push(current);
      if (windows.length === 1) first.release(); else second.release();
      return answer;
    } };
  } });
  const purchase = f.run(), handled = purchase.catch((error: unknown) => error);
  try {
    await first.wait;
    const old = windows[0]; if (!old) throw new Error('Missing first window');
    f.setLiveTotal(2_200);
    replies.answer({ purchaseId: old.purchaseId, windowId: old.windowId, action: 'approve' });
    await second.wait;
    const fresh = windows[1]; if (!fresh) throw new Error('Missing new price window');
    expect(fresh.windowId).not.toBe(old.windowId); expect(fresh.purchaseId).toBe(old.purchaseId);
    expect(old.notice).toContain('11.00'); expect(fresh.notice).toContain('22.00'); expect(fresh.kind).toBe('approval');
    expect(fresh.notice).toContain('Requested maximum: USD 15.00');
    expect(fresh.notice).toContain('full total exceeds your requested maximum');
    expect(() => replies.answer({ purchaseId: old.purchaseId, windowId: old.windowId, action: 'approve' })).toThrow(PaymentReplyWindowError);
    expect(f.records).toEqual([]); expect(replies.pending).toBe(1);
    replies.answer({ purchaseId: fresh.purchaseId, windowId: fresh.windowId, action: 'approve' });
    expect((await purchase).kind).toBe('purchased'); expect(f.records).toMatchObject([{ totalMinorUnits: 2_200, requestedMaximumMinorUnits: 1_500 }]);
    expect(deliveries).toBe(2); expect(replies.pending).toBe(0);
  } finally { await replies.close(); await handled; }
});

test('a cheaper replacement also voids the earlier answer and opens its own veto window', async () => {
  const f = fixture();
  Reflect.set(f.deps, 'limits', { ...f.deps.limits, dailyItemMinorUnits: 500 });
  f.deps.driver.readCurrentQuote = async () => ({ ...f.reading,
    lines: [{ label: 'Original item', quantity: '1', unitPrice: '$5.00' }], tax: '$0.50', statedTotal: '$5.50' });
  let windows = 0;
  f.deps.notifier.awaitAnswer = async input => {
    if (++windows === 1) { expect(input.kind).toBe('approval'); f.setLiveTotal(550); return { answer: 'approve', channel: 'operator' }; }
    expect(windows).toBe(2); expect(input.kind).toBe('veto');
    return { answer: 'object', channel: 'operator' };
  };
  expect(await f.run()).toMatchObject({ kind: 'cancelled' });
  expect(f.notices.map(notice => notice.kind)).toEqual(['approval', 'veto']); expect(f.notices[1]?.message).toContain('5.50');
  expect(f.records).toEqual([]); expect(f.effects).not.toContain('card-read');
  expect(f.ledger.state().reservations).toEqual([]); expect(await f.journal.list()).toEqual([]);
});

test('the original checkout owns its page while repricing even with no budget reservation or journal row', async () => {
  const f = fixture(); f.onTerms(async () => false);
  f.deps.driver.readCurrentQuote = async () => {
    expect(f.ledger.state().reservations).toEqual([]); expect(await f.journal.list()).toEqual([]);
    await expect(runCheckout({ ...f.request, purchaseId: 'competing-purchase' }, f.reading, f.controls, f.deps)).rejects.toThrow('already belongs');
    return null;
  };
  expect(await f.run()).toMatchObject({ kind: 'refused', code: 'total-changed' });
  expect(f.notices).toHaveLength(1); expect(f.effects).not.toContain('card-read');
  expect(f.ledger.state().reservations).toEqual([]);
  // The failed original operation eventually releases its own page claim.
  const next = f.deps.registry.claimPage('session', 'page'); next.release();
});

test('a replacement quote cannot adopt a later stored address after the original address owner retires', async () => {
  const f = fixture(); let originalAddressCurrent = true, preparations = 0;
  const address = { name: 'Fixture Owner', line1: '100 Example Street', line2: '', city: 'Chicago', region: 'IL', postalCode: '60601', country: 'US' };
  Reflect.set(f.controls, 'addressFields', [{ kind: 'shipping', field: 'name', target: 'ship-name' }]);
  Reflect.set(f.deps, 'addresses', {
    async read() { return address; },
    async prepare() {
      const original = ++preparations === 1;
      return { assertCurrent() { if (original && !originalAddressCurrent) throw new Error('Original stored address retired'); }, async read() { return original ? address : { ...address, line1: 'Different destination' }; } };
    },
  });
  f.onTerms(async () => false);
  f.onMerchant(async () => { if (f.merchantCalls() === 2) originalAddressCurrent = false; });
  f.deps.driver.readCurrentQuote = async () => ({ ...f.reading,
    lines: [{ label: 'Original item', quantity: '1', unitPrice: '$20.00' }], tax: '$2.00', statedTotal: '$22.00' });
  await expect(f.run()).rejects.toBeInstanceOf(CheckoutOwnershipError);
  expect(preparations).toBe(1); expect(f.notices).toHaveLength(1); expect(f.effects).not.toContain('card-read');
  expect(f.records).toEqual([]); expect(f.ledger.state().reservations).toEqual([]); expect(await f.journal.list()).toEqual([]);
});
