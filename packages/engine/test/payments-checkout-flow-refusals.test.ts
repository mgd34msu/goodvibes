import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { BudgetLedger } from '../platform/src/platform/payments/budget.js';
import { CardMaterialRedactor } from '../platform/src/platform/payments/card-redaction.js';
import { CheckoutRegistry, MemoryCheckoutJournal } from '../platform/src/platform/payments/checkout-registry.js';
import { readCheckoutReadingInput } from '../platform/src/platform/payments/checkout-reading-input.js';
import { runCheckout, type CheckoutFlowDeps, type CheckoutControls, type PurchaseRequest } from '../platform/src/platform/payments/checkout-flow.js';
import type { CheckoutTerms } from '../platform/src/platform/payments/checkout-page.js';
import type { RawCheckoutReading } from '../platform/src/platform/payments/checkout-extraction.js';
import type { PurchaseRecord } from '../platform/src/platform/payments/purchase-record.js';
import { parseCurrencyCode, unsafeOwnerSuppliedTextForTests } from '../platform/src/platform/payments/types.js';
import { UntrustedContentLedger } from '../platform/src/platform/security/untrusted-content.js';
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
function fixture(requestedMax?: string) {
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
    item: unsafeOwnerSuppliedTextForTests('Original item'), requestedLines: [{ label: 'Original item', quantity: 1 }], cardId: 'card', preferredTier: 'normal',
    ...(requestedMax === undefined ? {} : { requestedMax }) };
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


const LUHN_VALID_BARCODE = '4222222222222';

test('a card-shaped number in the order summary is refused with a reason that says what to change', async () => {
  const f = fixture();
  Reflect.set(f.reading, 'orderSummaryText', `One original item. UPC ${LUHN_VALID_BARCODE}`);
  const outcome = await f.run();
  expect(outcome).toMatchObject({ kind: 'refused', code: 'extraction-failed' });
  expect(outcome.kind === 'refused' ? outcome.reason : '').toContain('card number');
  expect(f.effects).not.toContain('card-read'); expect(f.records).toEqual([]);
  expect(f.ledger.state().reservations).toEqual([]); expect(await f.journal.list()).toEqual([]);
});

test('an order summary too long to be read whole is refused, not thrown', async () => {
  const f = fixture();
  Reflect.set(f.reading, 'orderSummaryText', 'One original item. '.repeat(1_200));
  const outcome = await f.run();
  expect(outcome).toMatchObject({ kind: 'refused', code: 'extraction-failed' });
  expect(outcome.kind === 'refused' ? outcome.reason : '').toContain('too long');
  expect(f.records).toEqual([]);
});

test('the reading input refuses a summary the recurring-charge reading could not take', () => {
  const params = { lines: [{ label: 'Item', quantity: '1', unitPrice: '$10.00' }], shippingOptions: [{ label: 'Standard', cost: '$0.00' }] };
  expect(readCheckoutReadingInput({ ...params, orderSummaryText: 'x'.repeat(25_000) })).toMatchObject({ ok: false, field: 'orderSummaryText' });
  expect(readCheckoutReadingInput({ ...params, orderSummaryText: 'x'.repeat(20_000) }).ok).toBe(true);
});

test('a stop during delivery option selection is not reported as a page problem', async () => {
  const f = fixture();
  const controller = new AbortController();
  Reflect.set(f.deps, 'signal', controller.signal);
  f.onChoose(async () => { controller.abort(new Error('stopped')); throw new Error('page closed'); });
  await expect(f.run()).rejects.toBeDefined();
  expect(f.effects.some(effect => effect.startsWith('submit:'))).toBe(false);
});

test('a delivery option that cannot be selected is still a stated refusal', async () => {
  const f = fixture();
  f.onChoose(async () => { throw new Error('option gone'); });
  expect(await f.run()).toMatchObject({ kind: 'refused', code: 'total-changed' });
});

test('the report after a purchase expects no reply', async () => {
  const f = fixture();
  expect((await f.run()).kind).toBe('purchased');
  expect(f.notices.at(-1)?.kind).toBe('notice');
});

test('a purchase whose budget write is still pending keeps its journal entry', async () => {
  const f = fixture();
  f.ledger.flush = () => { throw new Error('disk full'); };
  expect((await f.run()).kind).toBe('purchased');
  expect(f.records).toHaveLength(1);
  expect(await f.journal.list()).toMatchObject([{ purchaseId: 'owned-purchase', phase: 'submitted' }]);
});

test('a purchase whose budget write landed closes its journal entry', async () => {
  const f = fixture();
  expect((await f.run()).kind).toBe('purchased');
  expect(await f.journal.list()).toEqual([]);
});
