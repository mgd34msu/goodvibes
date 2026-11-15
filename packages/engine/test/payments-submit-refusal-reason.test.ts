import { expect, test } from 'bun:test';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { createBrowserCheckoutDriverFactory, type CheckoutBrowserEngine } from '../platform/src/platform/payments/browser-checkout-driver.js';
import { CardMaterialRedactor } from '../platform/src/platform/payments/card-redaction.js';
import { CheckoutSubmitRefused, type CheckoutTerms } from '../platform/src/platform/payments/checkout-page.js';
import { parseCurrencyCode } from '../platform/src/platform/payments/types.js';

const currency = (() => { const parsed = parseCurrencyCode('USD'); if (!parsed) throw new Error('Invalid fixture currency'); return parsed; })();
const terms: CheckoutTerms = { submitTarget: 'e1', merchantDomain: 'merchant.example', currency,
  lines: [{ label: 'Cable', quantity: 1, unitMinorUnits: 1_000 }], taxMinorUnits: 100, feesMinorUnits: 0, feeLabels: [],
  shippingLabel: 'Standard', shippingMinorUnits: 200, totalMinorUnits: 1_300 };
const observation = { url: 'https://merchant.example/checkout', submitControl: { ref: 'e1', selector: '#buy', frameChain: [], name: 'Place order', role: 'button', submits: true },
  documents: [{ frameChain: [], url: 'https://merchant.example/checkout', controls: [{ selector: '#buy', name: 'Place order', role: 'button', submits: true }],
    checkout: { text: 'Cable x1: USD 10.00\nTax: USD 1.00\nStandard selected: USD 2.00\nOne-off total: USD 13.00', selections: [{ selector: '#shipping', labels: ['Standard'] }], quantities: [] } }] };

test('a submit refused by its own final verification keeps that reason, not an address-change reason', async () => {
  const guard = new CardMaterialRedactor();
  const previous = installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
  let armed = false, checks = 0, clicks = 0;
  const unavailable = async (): Promise<never> => { throw new Error('Unexpected page operation'); };
  const engine: CheckoutBrowserEngine = { cardFieldGuard: () => guard,
    tabs: async () => ({ pages: [{ pageId: 'page', url: 'https://merchant.example/checkout' }] }),
    type: unavailable, fillSecretBatch: unavailable, select: unavailable,
    click: async (_target, _args, owner) => { clicks++; await owner?.beforeDispatch?.(); return {}; },
    async observeCheckoutTerms(_target, owner) {
      owner.assertCurrent();
      return { state: observation, assertCurrent: async () => {
        // After verification the page is re-read once, immediately before dispatch, and cannot be read.
        if (armed && ++checks > 0) throw new Error('page unreadable');
      } };
    },
  };
  try {
    const driver = createBrowserCheckoutDriverFactory({ engineFor: async () => engine, cardFieldGuard: guard })('session', 'page');
    expect(await driver.verifyTerms?.(terms, { assertCurrent() {} })).toBe(true);
    armed = true;
    const failure = await driver.submitOrder('e1', { assertCurrent() {} }).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(CheckoutSubmitRefused);
    expect((failure as Error).message).toBe('The current checkout could not be verified before submission.');
    expect(clicks).toBe(1);
  } finally { installJudgmentPort(previous); }
});
