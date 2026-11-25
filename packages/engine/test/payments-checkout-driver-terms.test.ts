// Proves: With no decision model, code's last look at the page accepts one that does not show the approved total.
// Red when: The browser checkout driver's code check takes the approved total from inside a longer number, or accepts the page on another domain, over plain http, or with another submit control.
/**
 * On an install with no decision model, the browser checkout driver's own code
 * makes the last check before the order is placed: the page is the merchant's,
 * over https, with the submit control the owner's quote named, and it prints
 * the approved total as a number of its own. Anything else is a changed quote,
 * never a submit.
 *
 * The real driver from `createBrowserCheckoutDriverFactory`. Stand-in: the
 * browser's observation of the page, as data.
 */
import { expect, test } from 'bun:test';
import { createBrowserCheckoutDriverFactory, type CheckoutBrowserEngine } from '../platform/src/platform/payments/browser-checkout-driver.ts';
import type { CheckoutTerms } from '../platform/src/platform/payments/checkout-page.ts';
import { money } from '../platform/src/platform/payments/money.ts';
import { parseCurrencyCode, type CurrencyCode } from '../platform/src/platform/payments/types.ts';
import { configureDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.ts';

const TERMS: CheckoutTerms = {
  submitTarget: 'place', merchantDomain: 'shop.example',
  lines: [{ label: 'Kettle', quantity: 1, unitMinorUnits: 1_099 }], taxMinorUnits: 0, feesMinorUnits: 0, feeLabels: [],
  shippingLabel: 'Standard', shippingMinorUnits: 200, total: money(1_299, parseCurrencyCode('USD') as CurrencyCode),
};

function driverOn(page: { url: string; submit: string; text: string }) {
  const unused = async (): Promise<Record<string, unknown>> => { throw new Error('not part of the terms check'); };
  const guard = { hasLiveMaterial: () => true };
  const engine: CheckoutBrowserEngine = {
    cardFieldGuard: () => guard, tabs: unused, type: unused, fillSecretBatch: unused, select: unused, click: unused,
    observeCheckoutTerms: async () => ({
      state: { url: page.url, submitControl: { ref: page.submit }, documents: [{ checkout: { text: page.text } }] },
      assertCurrent: async () => {},
    }),
  };
  const factory = createBrowserCheckoutDriverFactory({ engineFor: async () => engine, cardFieldGuard: guard });
  return factory('session-1', 'page-1');
}

test('with no decision model, only the merchant\'s page with the approved total and submit control passes the last check', async () => {
  const retire = configureDecisionModelPolicy(() => 'Hybrid', () => false);
  try {
    const shown = (page: { url: string; submit: string; text: string }) => {
      const driver = driverOn(page);
      if (!driver.verifyTerms) throw new Error('The browser checkout driver no longer checks the terms on the live page.');
      return driver.verifyTerms(TERMS, { assertCurrent: () => {} });
    };
    const checkout = { url: 'https://www.shop.example/checkout', submit: 'place', text: 'Kettle $10.99 Standard delivery $2.00 Total $12.99' };
    expect(await shown(checkout)).toBe(true);
    expect(await shown({ ...checkout, text: 'Kettle $110.99 Standard delivery $2.00 Total $112.99' })).toBe(false);
    expect(await shown({ ...checkout, url: 'https://www.shop.example.evil.example/checkout' })).toBe(false);
    expect(await shown({ ...checkout, url: 'http://www.shop.example/checkout' })).toBe(false);
    expect(await shown({ ...checkout, submit: 'subscribe-and-save' })).toBe(false);
  } finally {
    retire();
  }
});
