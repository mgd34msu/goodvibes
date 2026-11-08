import { afterEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { createBrowserCheckoutDriverFactory, type CheckoutBrowserEngine } from '../sdk/src/platform/payments/browser-checkout-driver.js';
import { CheckoutSubmitRefused, type CheckoutTerms } from '../sdk/src/platform/payments/checkout-page.js';
import { CardMaterialRedactor } from '../sdk/src/platform/payments/card-redaction.js';
import { parseCurrencyCode } from '../sdk/src/platform/payments/types.js';
import { paymentsPort } from './helpers/payments-readings.ts';

const restores: (() => void)[] = [], releases: (() => void)[] = [], pending: Promise<unknown>[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(pending.splice(0));
  for (const restore of restores.splice(0).reverse()) restore();
});
function barrier() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; }); releases.push(release);
  return { wait, release };
}
function fixture(verdict: boolean | 'unsure' = true) {
  const currency = parseCurrencyCode('USD'); if (!currency) throw new Error('Invalid fixture currency');
  const expected: CheckoutTerms = {
    submitTarget: 'place',
    merchantDomain: 'bestbuy.com', currency, lines: [{ label: 'Cable', quantity: 1, unitMinorUnits: 1_000 }],
    taxMinorUnits: 100, feesMinorUnits: 0, feeLabels: [], shippingLabel: 'Standard', shippingMinorUnits: 0, totalMinorUnits: 1_100,
  };
  const effects: string[] = [], guard = new CardMaterialRedactor();
  let revision = 1, active = true, url = 'https://www.bestbuy.com/checkout';
  let beforeAnswer = async () => {}, beforeDispatch = async () => {};
  const fake = paymentsPort({ currentTerms: () => verdict });
  const previous = installJudgmentPort({ ...fake.port, async ask(request) { await beforeAnswer(); return fake.port.ask(request); } });
  restores.push(() => { installJudgmentPort(previous); });
  const current = (): void => { if (!active) throw new Error('Original purchase owner retired'); };
  const engine: CheckoutBrowserEngine = {
    cardFieldGuard: () => guard,
    tabs: async () => ({ pages: [{ pageId: 'page', url }] }),
    type: async () => { effects.push('fill'); revision++; return {}; },
    fillSecretBatch: async (_target, args) => ({ filled: args.fills.map(field => field.ref), failedRef: null }),
    select: async () => { effects.push('choose'); revision++; return {}; },
    async observeCheckoutTerms(_target, owner, submitTarget) {
      owner.assertCurrent(); const original = revision;
      return { state: { url, submitControl: { ref: submitTarget, selector: '#place', frameChain: [], name: 'Place order', role: 'button', submits: true },
        documents: [{ frameChain: [], checkout: { text: 'Cable x1 USD $10.00. Tax $1.00. Standard selected, free. One-off total USD $11.00.' } }] },
        async assertCurrent() { owner.assertCurrent(); if (revision !== original) throw new Error('Current quote changed'); } };
    },
    async click(_target, _args, owner) {
      owner?.assertCurrent(); await beforeDispatch(); owner?.assertCurrent();
      await owner?.beforeDispatch?.(); owner?.assertCurrent();
      effects.push('click'); return { url: 'https://www.bestbuy.com/done', navigated: true };
    },
  };
  const driver = createBrowserCheckoutDriverFactory({ engineFor: async () => engine, cardFieldGuard: guard })('session', 'page');
  const verify = () => {
    if (!driver.verifyTerms) throw new Error('The actual driver has no terms reader');
    const work = driver.verifyTerms(expected, { assertCurrent: current }); pending.push(work); void work.catch(() => {}); return work;
  };
  return { driver, engine, expected, effects, requests: fake.requests, verify,
    change: () => { revision++; }, revoke: () => { active = false; }, redirect: (value: string) => { url = value; },
    beforeAnswer: (callback: () => Promise<void>) => { beforeAnswer = callback; },
    beforeDispatch: (callback: () => Promise<void>) => { beforeDispatch = callback; } };
}

test('submit requires the actual fresh quote and consumes it exactly once', async () => {
  const f = fixture();
  await expect(f.driver.submitOrder('place')).rejects.toBeInstanceOf(CheckoutSubmitRefused);
  expect(f.effects).toEqual([]); expect(f.requests).toEqual([]);
  expect(await f.verify()).toBe(true);
  expect(f.requests[0]?.state).toMatchObject({ expected: { total: 'USD 11.00', lines: [{ quantity: 1, unitPrice: 'USD 10.00' }] } });
  expect(await f.driver.submitOrder('place')).toMatchObject({ verified: false, orderId: null });
  await expect(f.driver.submitOrder('place')).rejects.toBeInstanceOf(CheckoutSubmitRefused);
  expect(f.effects).toEqual(['click']);
});

test('a verified quote cannot be consumed by another submit control', async () => {
  const f = fixture(); expect(await f.verify()).toBe(true);
  await expect(f.driver.submitOrder('different-button')).rejects.toBeInstanceOf(CheckoutSubmitRefused);
  expect(f.effects).toEqual([]);
});

test.each([false, 'unsure'] as const)('a %s quote reading cannot reach the submit actuator', async verdict => {
  const f = fixture(verdict);
  expect(await f.verify()).toBe(false);
  await expect(f.driver.submitOrder('place')).rejects.toBeInstanceOf(CheckoutSubmitRefused);
  expect(f.effects).toEqual([]);
});

test.each(['https://attacker.invalid/checkout', 'http://www.bestbuy.com/checkout'])('an unauthorized checkout origin %s refuses before asking the quote reader', async url => {
  const f = fixture(); f.redirect(url);
  expect(await f.verify()).toBe(false); expect(f.requests).toEqual([]);
  await expect(f.driver.submitOrder('place')).rejects.toBeInstanceOf(CheckoutSubmitRefused);
  expect(f.effects).toEqual([]);
});

test('the expected purchase detaches before a suspended quote reading', async () => {
  const f = fixture(), entered = barrier(), wait = barrier();
  f.beforeAnswer(async () => { entered.release(); await wait.wait; });
  const verifying = f.verify(); await entered.wait;
  Reflect.set(f.expected, 'totalMinorUnits', 99_900);
  Reflect.set(f.expected.lines[0] ?? {}, 'quantity', 99);
  wait.release(); expect(await verifying).toBe(true);
  expect(f.requests[0]?.state).toMatchObject({ expected: { total: 'USD 11.00', lines: [{ quantity: 1 }] } });
});

test.each(['quote', 'owner'] as const)('%s changes during a model await cannot publish a reusable quote', async change => {
  const f = fixture(), entered = barrier(), wait = barrier();
  f.beforeAnswer(async () => { entered.release(); await wait.wait; });
  const verifying = f.verify().catch((error: unknown) => error); await entered.wait;
  if (change === 'quote') f.change(); else f.revoke();
  wait.release(); expect(await verifying).toBeInstanceOf(Error);
  await expect(f.driver.submitOrder('place')).rejects.toBeInstanceOf(CheckoutSubmitRefused);
  expect(f.effects).toEqual([]);
});

test('a quote change during later browser checks is caught at the final dispatch boundary', async () => {
  const f = fixture(), entered = barrier(), wait = barrier();
  expect(await f.verify()).toBe(true);
  f.beforeDispatch(async () => { entered.release(); await wait.wait; });
  const submission = f.driver.submitOrder('place'); pending.push(submission); void submission.catch(() => {});
  await entered.wait; f.change(); wait.release();
  await expect(submission).rejects.toBeInstanceOf(CheckoutSubmitRefused);
  expect(f.effects).toEqual([]);
});

test('editing shipping or address invalidates an earlier quote until it is read again', async () => {
  const f = fixture(); expect(await f.verify()).toBe(true);
  await f.driver.fill('city', 'Detroit');
  await expect(f.driver.submitOrder('place')).rejects.toBeInstanceOf(CheckoutSubmitRefused);
  expect(f.effects).toEqual(['fill']);
  expect(await f.verify()).toBe(true);
  await f.driver.submitOrder('place'); expect(f.effects).toEqual(['fill', 'click']);
});

test('an unavailable decision model never creates an actionable quote', async () => {
  const f = fixture(); f.beforeAnswer(async () => { throw new JudgmentError('unavailable', 'No decision models available'); });
  await expect(f.verify()).rejects.toMatchObject({ kind: 'unavailable' });
  await expect(f.driver.submitOrder('place')).rejects.toBeInstanceOf(CheckoutSubmitRefused);
  expect(f.effects).toEqual([]);
});
