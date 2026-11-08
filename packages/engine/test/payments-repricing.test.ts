import { describe, expect, test } from 'bun:test';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { NONE } from '@goodvibes-jev/judgment';
import { checkoutAmountCandidates, checkoutRepriceAmount, checkoutRepriceShape, readRepricedCheckout } from '../sdk/src/platform/payments/checkout-repricing.js';
import { checkoutTerms } from '../sdk/src/platform/payments/batteries/checkout-terms.js';
import type { CheckoutTerms } from '../sdk/src/platform/payments/checkout-page.js';
import type { RawCheckoutReading } from '../sdk/src/platform/payments/checkout-extraction.js';
import { extractCheckout } from '../sdk/src/platform/payments/checkout-extraction.js';
import { parseCurrencyCode, unsafeOwnerSuppliedTextForTests } from '../sdk/src/platform/payments/types.js';
import { CheckoutRegistry, CheckoutRegistryError, MemoryCheckoutJournal, type InFlightCheckout } from '../sdk/src/platform/payments/checkout-registry.js';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { createBrowserCheckoutDriverFactory, type CheckoutBrowserEngine } from '../sdk/src/platform/payments/browser-checkout-driver.js';
import { CardMaterialRedactor } from '../sdk/src/platform/payments/card-redaction.js';
import { CheckoutSubmitRefused } from '../sdk/src/platform/payments/checkout-page.js';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Missing complete authored fixture state');
  return value as Record<string, unknown>;
}
const currency = (() => { const parsed = parseCurrencyCode('USD'); if (!parsed) throw new Error('Invalid fixture currency'); return parsed; })();
function fixture() {
  const previous: CheckoutTerms = { submitTarget: 'e1', merchantDomain: 'merchant.example', currency,
    lines: [{ label: 'Cable', quantity: 1, unitMinorUnits: 1_000 }], taxMinorUnits: 100, feesMinorUnits: 0, feeLabels: [],
    shippingLabel: 'Standard', shippingMinorUnits: 200, totalMinorUnits: 1_300 };
  const reading: RawCheckoutReading = { lines: [{ label: 'Cable', quantity: '1', unitPrice: '10.00' }], tax: '1.00', fees: [],
    shippingOptions: [{ label: 'Standard', cost: '2.00' }, { label: 'Express', cost: '4.00' }], statedTotal: '13.00', currency: 'USD', orderSummaryText: 'One-off Cable purchase' };
  const current = { url: 'https://merchant.example/checkout', submitControl: { ref: 'e1', selector: '#buy', frameChain: [], name: 'Place order', role: 'button', submits: true },
    documents: [{ frameChain: [], url: 'https://merchant.example/checkout', controls: [{ selector: '#buy', name: 'Place order', role: 'button', submits: true }],
      checkout: { text: 'Cable x1: USD 12.00\nTax: USD 1.20\nStandard selected: USD 2.00\nExpress: USD 4.00\nMandatory handling: USD 0.50\nOne-off total: USD 15.70', selections: [{ selector: '#shipping', labels: ['Standard'] }], quantities: [] } }] };
  return { previous, reading, current };
}
function reader(options: { readonly shape?: number; readonly final?: number; readonly uncertain?: boolean; readonly omit?: string; readonly duplicateFee?: boolean; readonly wrongTotal?: boolean } = {}) {
  let feePicks = 0;
  return fakePort((name, question, state) => {
    const root = record(state);
    if (name === 'samePurchase') return noulAnswer(options.shape ?? 0.99);
    if (name === 'unchanged') {
      const expected = record(root['expected']);
      expect(expected['tax']).toBe('USD 1.20'); expect(expected['fees']).toBe('USD 0.50'); expect(expected['total']).toBe('USD 15.70');
      return noulAnswer(options.final ?? 0.99);
    }
    const context = record(root['context']), role = context['role'];
    if (typeof role !== 'string' || !Array.isArray(root['candidates'])) throw new Error('Missing exact repricing selector');
    const rows = root['candidates'].map(row => ({ id: record(row)['id'], content: record(record(row)['content']) }));
    let literal: string | undefined;
    if (role.startsWith('unit price')) literal = '12.00';
    else if (role.startsWith('total sales tax')) literal = '1.20';
    else if (role.startsWith('delivery price') && role.includes('Standard')) literal = '2.00';
    else if (role.startsWith('delivery price') && role.includes('Express')) literal = '4.00';
    else if (role.startsWith('final payable total')) literal = options.wrongTotal ? '12.00' : '15.70';
    else if (role === 'next-mandatory-fee') {
      if (!Array.isArray(context['selectedFees'])) throw new Error('Missing prior distinct fee evidence');
      literal = context['selectedFees'].length === 0 || options.duplicateFee ? '0.50' : undefined;
    } else throw new Error('Unexpected repricing role');
    const selected = options.omit && role.startsWith(options.omit) ? undefined : rows.find(row => row.content['literal'] === literal);
    const id = typeof selected?.id === 'string' ? selected.id : NONE;
    if (name === 'pick') { if (role === 'next-mandatory-fee') feePicks++; return choiceAnswer(question, id, options.uncertain ? 0.5 : 0.99); }
    if (!name.startsWith('fits_')) throw new Error('Unexpected repricing question');
    const index = Number(name.slice(5));
    expect(feePicks).toBeLessThanOrEqual(2);
    return noulAnswer(rows[index]?.id === id ? 0.99 : 0.01);
  });
}

describe('source amount syntax', () => {
  test('retains exact spans and grouped amounts without reconstituting source prices', () => {
    const text = 'Cable 1,234.56; tax 12.34; total 1 246.90';
    const candidates = checkoutAmountCandidates([text], 'USD');
    expect(candidates?.map(candidate => candidate.content.literal)).toEqual(['1,234.56', '12.34', '1 246.90']);
    for (const candidate of candidates ?? []) expect(text.slice(candidate.content.start, candidate.content.end)).toBe(candidate.content.literal);
  });
  test('negative and invalid full numerals never become positive suffix candidates', () => {
    expect(checkoutAmountCandidates(['-1 234.56; (12.00); −3.00; –4.00; 1,23,456; 1e6; -1e6; 0x10; 10 - 12; 1/2; valid 5.00'], 'USD')?.map(candidate => candidate.content.literal)).toEqual(['5.00']);
  });
  test('refuses a candidate overflow rather than silently dropping later amounts', () => {
    expect(checkoutAmountCandidates([Array.from({ length: 193 }, (_, index) => `${index}.00`).join('; ')], 'USD')).toBeNull();
  });
});

test('replacement quote uses exact current source amounts and a complete final verification', async () => {
  const input = fixture(), scripted = reader(); let currentChecks = 0;
  const result = await readRepricedCheckout({ ...input, port: scripted.port, assertCurrent: async () => { currentChecks++; } });
  expect(result).not.toBeNull(); if (!result) throw new Error('Fresh fixture quote was not returned');
  expect(result.lines).toEqual([{ label: 'Cable', quantity: '1', unitPrice: '12.00' }]);
  expect(result.tax).toBe('1.20'); expect(result.fees.map(fee => fee.amount)).toEqual(['0.50']);
  expect(result.shippingOptions).toEqual([{ label: 'Standard', cost: '2.00' }, { label: 'Express', cost: '4.00' }]);
  expect(result.statedTotal).toBe('15.70'); expect(Object.isFrozen(result)).toBe(true);
  const extracted = extractCheckout(result, currency); expect(extracted.ok).toBe(true);
  expect(currentChecks).toBeGreaterThan(1);
  expect(scripted.requests[0]?.context?.battery).toBe(checkoutRepriceShape.name);
  expect(scripted.requests.at(-1)?.context?.battery).toBe(checkoutTerms.name);
  expect(scripted.requests.filter(request => request.context?.battery === checkoutRepriceAmount.name)).toHaveLength(7);
});

test('replacement delivery prices can come from native select options absent from rendered body text', async () => {
  const input = fixture(), scripted = reader();
  const document = input.current.documents[0]; if (!document) throw new Error('Missing original checkout document');
  document.checkout.text = document.checkout.text.replace('Standard selected: USD 2.00\nExpress: USD 4.00\n', 'Standard selected\n');
  const current = { ...input.current, documents: [{ ...document, checkout: { ...document.checkout,
    selections: [{ selector: '#shipping', labels: ['Standard'], options: ['Standard USD 2.00', 'Express USD 4.00'] }] } }] };
  const result = await readRepricedCheckout({ ...input, current, port: scripted.port, assertCurrent: async () => {} });
  expect(result?.shippingOptions).toEqual([{ label: 'Standard', cost: '2.00' }, { label: 'Express', cost: '4.00' }]);
});

for (const options of [{ shape: 0.5 }, { shape: 0.01 }, { uncertain: true }, { omit: 'unit price' }, { duplicateFee: true }, { wrongTotal: true }, { final: 0.5 }, { final: 0.01 }])
  test(`unestablished or inconsistent replacement never reaches a new purchase: ${JSON.stringify(options)}`, async () => {
    const input = fixture(), scripted = reader(options);
    expect(await readRepricedCheckout({ ...input, port: scripted.port, assertCurrent: async () => {} })).toBeNull();
  });

test('a retired original quote owner cannot publish replacement prices', async () => {
  const input = fixture(), scripted = reader(); let checks = 0;
  await expect(readRepricedCheckout({ ...input, port: scripted.port, assertCurrent: async () => {
    if (++checks > 2) throw new Error('Original page owner retired');
  } })).rejects.toThrow('Original page owner retired');
  expect(scripted.requests.at(-1)?.context?.battery).not.toBe(checkoutTerms.name);
});

test('the production browser adapter reads replacement prices but does not mint a submit approval', async () => {
  const input = fixture(), scripted = reader(), guard = new CardMaterialRedactor(); let clicks = 0;
  const previous = installJudgmentPort(scripted.port);
  const unavailable = async (): Promise<never> => { throw new Error('Repricing must not type, select or submit'); };
  const engine: CheckoutBrowserEngine = { cardFieldGuard: () => guard,
    tabs: async () => ({ pages: [{ pageId: 'page', url: 'https://merchant.example/checkout' }] }),
    type: unavailable, fillSecretBatch: unavailable, select: unavailable,
    click: async () => { clicks++; return {}; },
    async observeCheckoutTerms(target, owner, submitTarget) {
      owner.assertCurrent(); expect(target).toEqual({ sessionId: 'session', pageId: 'page' }); expect(submitTarget).toBe('e1');
      return { state: input.current, assertCurrent: async () => { owner.assertCurrent(); } };
    },
  };
  try {
    const dependencies = { engineFor: async () => engine, cardFieldGuard: guard };
    const factory = createBrowserCheckoutDriverFactory(dependencies);
    Reflect.set(dependencies, 'engineFor', unavailable);
    const driver = factory('session', 'page');
    if (!driver.readCurrentQuote) throw new Error('Production checkout adapter has no replacement quote reader');
    const next = await driver.readCurrentQuote({ terms: input.previous, reading: input.reading }, { assertCurrent() {} });
    expect(next?.statedTotal).toBe('15.70'); expect(next?.lines[0]?.unitPrice).toBe('12.00');
    await expect(driver.submitOrder('e1')).rejects.toBeInstanceOf(CheckoutSubmitRefused);
    expect(clicks).toBe(0);
  } finally { installJudgmentPort(previous); }
});

for (const variant of ['subtotal-overflow', 'shipping-overflow', 'exact-safe-subtotal'] as const)
  test(`parsed checkout arithmetic preserves exact minor units: ${variant}`, () => {
    const raw: RawCheckoutReading = {
      lines: [{ label: 'Owner-requested bulk goods', quantity: '9999', unitPrice: '9000000000.00' }],
      tax: '0', fees: Array.from({ length: variant === 'subtotal-overflow' ? 9 : 8 }, (_, index) => ({ label: `Mandatory fee ${index}`, amount: '10000000000.00' })),
      shippingOptions: [{ label: 'Standard', cost: variant === 'shipping-overflow' ? '10000000000.00' : '0' }],
      statedTotal: null, currency: 'USD', orderSummaryText: 'One-off bulk order',
    };
    const result = extractCheckout(raw, currency);
    if (variant === 'exact-safe-subtotal') {
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.checkout.subtotalMinorUnits).toBe(9_007_100_000_000_000);
    } else expect(result).toMatchObject({ ok: false, field: variant === 'subtotal-overflow' ? 'subtotal' : 'shippingOptions' });
  });

test('explicit free components use the fixed zero option without fabricating a numeric source span', async () => {
  const input = fixture();
  const current = { ...input.current, documents: [{ checkout: {
    text: 'One Cable free. No tax or mandatory fees. Standard selected, free. Express free. Final one-off payable amount: free.',
    selections: [{ selector: '#shipping', labels: ['Standard'] }], quantities: [],
  } }] };
  const scripted = fakePort((name, question, state) => {
    if (name === 'samePurchase') return noulAnswer(0.99);
    if (name === 'unchanged') {
      expect(record(record(state)['expected'])['total']).toBe('USD 0.00'); return noulAnswer(0.99);
    }
    const role = record(record(state)['context'])['role'];
    if (name === 'pick') return choiceAnswer(question, role === 'next-mandatory-fee' ? NONE : 'zero-charge', 0.99);
    return noulAnswer(role === 'next-mandatory-fee' ? 0.01 : 0.99);
  });
  const result = await readRepricedCheckout({ ...input, current, port: scripted.port, assertCurrent: async () => {} });
  expect(result?.statedTotal).toBe('0'); expect(result?.tax).toBe('0'); expect(result?.lines[0]?.unitPrice).toBe('0'); expect(result?.fees).toEqual([]);
});

test('page claims are original references and releasing an old claim cannot retire its successor', () => {
  const registry = new CheckoutRegistry(new MemoryCheckoutJournal()), first = registry.claimPage('session', 'page');
  expect(() => registry.claimPage('session', 'page')).toThrow(CheckoutRegistryError);
  const other = registry.claimPage('other-session', 'page');
  first.release(); const next = registry.claimPage('session', 'page');
  expect(() => first.assertCurrent()).toThrow(CheckoutRegistryError);
  first.release(); expect(() => next.assertCurrent()).not.toThrow(); expect(() => other.assertCurrent()).not.toThrow();
  next.release(); other.release();
});

test('a claimed page cannot be opened without the original claim or through a copied shape', async () => {
  const journal = new MemoryCheckoutJournal(), registry = new CheckoutRegistry(journal), claim = registry.claimPage('session', 'page');
  const entry: InFlightCheckout = { purchaseId: 'original-purchase', sessionId: 'session', pageId: 'page', merchantDomain: 'merchant.example', cardId: 'card',
    item: unsafeOwnerSuppliedTextForTests('Cable'), currency, phase: 'deciding', startedAtMs: 1, updatedAtMs: 1,
    draw: null, reservationId: null, shippingTierRequested: 'normal', shippingTierUsed: null, stepDown: null, totalMinorUnits: null };
  try {
    await expect(registry.open(entry)).rejects.toBeInstanceOf(CheckoutRegistryError);
    await expect(registry.open(entry, { ...claim })).rejects.toBeInstanceOf(CheckoutRegistryError);
    expect(await journal.list()).toEqual([]);
    await registry.open(entry, claim); await registry.close(entry.purchaseId);
    // Closing one price's journal does not end ownership of the purchase page.
    await expect(registry.open({ ...entry, purchaseId: 'another-purchase' })).rejects.toBeInstanceOf(CheckoutRegistryError);
    await registry.open(entry, claim); await registry.close(entry.purchaseId);
  } finally { claim.release(); }
  await expect(registry.open(entry)).resolves.toMatchObject({ purchaseId: entry.purchaseId });
  await registry.close(entry.purchaseId);
});
