import { expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { CardMaterialRedactor } from '../sdk/src/platform/payments/card-redaction.js';
import type { CardMaterial } from '../sdk/src/platform/payments/card-material.js';
import type { CheckoutPageDriver } from '../sdk/src/platform/payments/checkout-page.js';
import { CheckoutRegistry, MemoryCheckoutJournal } from '../sdk/src/platform/payments/checkout-registry.js';
import { createBrowserCheckoutDriverFactory, type CheckoutBrowserEngine } from '../sdk/src/platform/payments/browser-checkout-driver.js';
import { fillCard, FillCardRefusal, type FillCardRequest } from '../sdk/src/platform/payments/fill-card.js';
import { parseCurrencyCode, unsafeOwnerSuppliedTextForTests } from '../sdk/src/platform/payments/types.js';
import { paymentsPort, usePaymentsReadings } from './helpers/payments-readings.ts';

const readings = usePaymentsReadings();
function barrier() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}
const material: CardMaterial = { number: '4242424242424242', cvv: '321', expiryMonth: '07', expiryYear: '2029', cardholderName: 'Fixture Owner' };
async function fixture() {
  const registry = new CheckoutRegistry(new MemoryCheckoutJournal());
  const currency = parseCurrencyCode('USD');
  if (!currency) throw new Error('Invalid fixture currency');
  const original = { purchaseId: 'original-purchase', sessionId: 'session', pageId: 'page', merchantDomain: 'bestbuy.com', cardId: 'card',
    item: unsafeOwnerSuppliedTextForTests('Fixture item'), currency, phase: 'arming-payment' as const,
    startedAtMs: 1, updatedAtMs: 1, draw: null, reservationId: null, shippingTierRequested: 'normal' as const,
    shippingTierUsed: null, stepDown: null, totalMinorUnits: null };
  await registry.open(original);
  const redactor = new CardMaterialRedactor();
  const calls: string[] = [];
  const hooks = { url: async () => 'https://www.bestbuy.com/checkout', read: async (): Promise<CardMaterial | null> => material };
  const cards = { async metadata() { return null; }, async read() { calls.push('read-card'); return hooks.read(); } };
  const driver: CheckoutPageDriver = {
    identity: () => ({ sessionId: 'session', pageId: 'page' }),
    url: () => hooks.url(),
    async fill() { throw new Error('Unexpected ordinary fill'); },
    async fillSecrets(fields, ownership) {
      ownership?.assertCurrent();
      calls.push(...fields.map(field => `fill:${field.target}`));
      return { filledTargets: fields.map(field => field.target), failedTarget: null };
    },
    async choose() { throw new Error('Unexpected shipping selection'); },
    async submitOrder() { throw new Error('Card fill must not submit'); },
  };
  const request: FillCardRequest = { sessionId: 'session', pageId: 'page', targets: [{ field: 'number', target: 'original-ref' }] };
  return { registry, original, redactor, calls, hooks, cards, driver, request };
}

test('a closed and replaced purchase cannot resume card fill after a pending page lookup', async () => {
  const f = await fixture(); const gate = barrier();
  f.hooks.url = async () => { await gate.wait; return 'https://www.bestbuy.com/checkout'; };
  const fill = fillCard(f.request, f); void fill.catch(() => {});
  await f.registry.close('original-purchase');
  await f.registry.open({ ...f.original, purchaseId: 'replacement' });
  gate.release();
  await expect(fill).rejects.toBeInstanceOf(FillCardRefusal);
  expect(f.calls).toEqual([]);
  expect(readings.requests).toHaveLength(0);
  expect(f.redactor.hasLiveMaterial('session', 'page')).toBe(false);
});

test('pre-cancelled owners and asynchronous authority callbacks refuse before model or card access', async () => {
  const f = await fixture();
  const owner = new AbortController(); owner.abort(new Error('Private owner cancellation'));
  await expect(fillCard(f.request, { ...f, signal: owner.signal })).rejects.toBeInstanceOf(FillCardRefusal);
  await expect(fillCard(f.request, { ...f, assertCurrent: async () => { throw new Error('Private asynchronous owner failure'); } })).rejects.toBeInstanceOf(FillCardRefusal);
  expect(f.calls).toEqual([]);
  expect(readings.requests).toHaveLength(0);
  expect(f.redactor.hasLiveMaterial('session', 'page')).toBe(false);
});

test('purchase ownership is checked after a held decision-model domain reading', async () => {
  const f = await fixture(); const gate = barrier(); const entered = barrier();
  const fake = paymentsPort();
  const previous = installJudgmentPort({ model: fake.port.model, async ask(request) {
    entered.release(); await gate.wait; return fake.port.ask(request);
  } });
  try {
    const fill = fillCard(f.request, f); void fill.catch(() => {});
    await entered.wait;
    await f.registry.close('original-purchase');
    gate.release();
    await expect(fill).rejects.toBeInstanceOf(FillCardRefusal);
    expect(f.calls).toEqual([]);
    expect(f.redactor.hasLiveMaterial('session', 'page')).toBe(false);
  } finally { gate.release(); installJudgmentPort(previous); }
});

test('a phase change during card lookup prevents redaction arming and every field write', async () => {
  const f = await fixture(); const gate = barrier(); const entered = barrier();
  f.hooks.read = async () => { entered.release(); await gate.wait; return material; };
  const fill = fillCard(f.request, f); void fill.catch(() => {});
  await entered.wait;
  await f.registry.advance('original-purchase', 'submit-pending');
  gate.release();
  await expect(fill).rejects.toBeInstanceOf(FillCardRefusal);
  expect(f.calls).toEqual(['read-card']);
  expect(f.redactor.hasLiveMaterial('session', 'page')).toBe(false);
});

test('the original cancellation signal and address owner remain in force during card lookup', async () => {
  for (const cancel of [true, false]) {
    const f = await fixture(); const gate = barrier(); const entered = barrier();
    const owner = new AbortController(); const replacement = new AbortController();
    let addressCurrent = true;
    f.hooks.read = async () => { entered.release(); await gate.wait; return material; };
    const deps = { ...f, signal: owner.signal, assertCurrent: () => { if (!addressCurrent) throw new Error('Private address detail'); } };
    const fill = fillCard(f.request, deps); void fill.catch(() => {});
    await entered.wait;
    deps.signal = replacement.signal; deps.assertCurrent = () => {};
    if (cancel) owner.abort(new Error('Private cancellation reason')); else addressCurrent = false;
    gate.release();
    await expect(fill).rejects.toThrow('purchase changed or was cancelled');
    expect(f.calls).toEqual(['read-card']);
    expect(f.redactor.hasLiveMaterial('session', 'page')).toBe(false);
  }
});

test('later caller edits cannot change the page, fields or expiry options selected for a fill', async () => {
  const f = await fixture(); const gate = barrier(); const entered = barrier();
  f.hooks.url = async () => { entered.release(); await gate.wait; return 'https://www.bestbuy.com/checkout'; };
  const request = { ...f.request, targets: [{ field: 'number' as const, target: 'original-ref' }], expirySeparator: '/', twoDigitYear: false };
  const fill = fillCard(request, f);
  await entered.wait;
  request.sessionId = 'replacement-session'; request.pageId = 'replacement-page'; request.targets[0]!.target = 'replacement-ref';
  request.expirySeparator = ' '; request.twoDigitYear = true;
  gate.release();
  expect((await fill).ok).toBe(true);
  expect(f.calls).toEqual(['read-card', 'fill:original-ref']);
});

function engine(redactor: CardMaterialRedactor, fill: CheckoutBrowserEngine['fillSecretBatch']): CheckoutBrowserEngine {
  return { cardFieldGuard: () => redactor,
    async tabs() { return { pages: [{ pageId: 'page', url: 'https://www.bestbuy.com/checkout' }] }; },
    async type() { throw new Error('Unexpected ordinary type'); },
    fillSecretBatch: fill,
    async select() { throw new Error('Unexpected selection'); },
    async click() { throw new Error('Card fill must not click'); },
  };
}

test('real browser checkout adapter rechecks the purchase after lazy engine creation', async () => {
  const f = await fixture(); const gate = barrier(); const entered = barrier();
  let engineReads = 0, writes = 0;
  const browser = engine(f.redactor, async () => { writes++; return { filled: ['original-ref'], failedRef: null }; });
  const driver = createBrowserCheckoutDriverFactory({ cardFieldGuard: f.redactor,
    async engineFor() { engineReads++; if (engineReads === 2) { entered.release(); await gate.wait; } return browser; },
  })('session', 'page');
  const fill = fillCard(f.request, { ...f, driver });
  await entered.wait;
  await f.registry.close('original-purchase');
  gate.release();
  expect((await fill).ok).toBe(false);
  expect(writes).toBe(0);
  // Partial entry and cancellation do not disarm page-lifetime redaction.
  expect(f.redactor.hasLiveMaterial('session', 'page')).toBe(true);
});

test('real adapter forwards the original purchase guard and signal to the browser field writer', async () => {
  const f = await fixture(); const gate = barrier(); const entered = barrier();
  const owner = new AbortController();
  let forwarded: AbortSignal | undefined, writes = 0;
  const browser = engine(f.redactor, async (_target, _args, ownership) => {
    forwarded = ownership?.signal;
    entered.release(); await gate.wait;
    ownership?.assertCurrent();
    writes++;
    return { filled: ['original-ref'], failedRef: null };
  });
  const driver = createBrowserCheckoutDriverFactory({ cardFieldGuard: f.redactor, engineFor: async () => browser })('session', 'page');
  const fill = fillCard(f.request, { ...f, driver, signal: owner.signal });
  await entered.wait;
  expect(forwarded).toBe(owner.signal);
  owner.abort();
  gate.release();
  expect((await fill).ok).toBe(false);
  expect(writes).toBe(0);
  expect(f.redactor.hasLiveMaterial('session', 'page')).toBe(true);
});
