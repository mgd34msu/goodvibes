import { expect, test } from 'bun:test';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { createBrowserCheckoutDriverFactory, type CheckoutBrowserEngine } from '../platform/src/platform/payments/browser-checkout-driver.js';
import { CardMaterialRedactor } from '../platform/src/platform/payments/card-redaction.js';
import type { CheckoutTerms } from '../platform/src/platform/payments/checkout-page.js';
import { parseCurrencyCode } from '../platform/src/platform/payments/types.js';

const currency = (() => { const parsed = parseCurrencyCode('USD'); if (!parsed) throw new Error('Invalid fixture currency'); return parsed; })();
const terms: CheckoutTerms = { submitTarget: 'e1', merchantDomain: 'merchant.example', currency,
  lines: [{ label: 'Cable', quantity: 1, unitMinorUnits: 1_000 }], taxMinorUnits: 100, feesMinorUnits: 0, feeLabels: [], discounts: [],
  shippingLabel: 'Standard', shippingMinorUnits: 200, totalMinorUnits: 1_300 };
const observation = { url: 'https://merchant.example/checkout', submitControl: { ref: 'e1', selector: '#buy', frameChain: [], name: 'Place order', role: 'button', submits: true },
  documents: [{ frameChain: [], url: 'https://merchant.example/checkout', controls: [{ selector: '#buy', name: 'Place order', role: 'button', submits: true }],
    checkout: { text: 'Cable x1: USD 10.00\nTax: USD 1.00\nStandard selected: USD 2.00\nOne-off total: USD 13.00', selections: [{ selector: '#shipping', labels: ['Standard'] }], quantities: [] } }] };

test('one purchase reads the terms with a model once and re-reads the page twice', async () => {
  const guard = new CardMaterialRedactor();
  const port = fakePort(() => noulAnswer(0.99));
  const previous = installJudgmentPort(port.port);
  let observations = 0, rechecks = 0;
  const unavailable = async (): Promise<never> => { throw new Error('Unexpected page operation'); };
  const engine: CheckoutBrowserEngine = { cardFieldGuard: () => guard,
    tabs: async () => ({ pages: [{ pageId: 'page', url: 'https://merchant.example/checkout' }] }),
    type: unavailable, fillSecretBatch: unavailable, select: unavailable,
    click: async (_target, _args, owner) => { await owner?.beforeDispatch?.(); return { url: 'https://merchant.example/done' }; },
    async observeCheckoutTerms(_target, owner) {
      owner.assertCurrent(); observations++;
      return { state: observation, assertCurrent: async () => { rechecks++; } };
    },
  };
  try {
    const driver = createBrowserCheckoutDriverFactory({ engineFor: async () => engine, cardFieldGuard: guard })('session', 'page');
    // Before the card: code-only page, domain and control check.
    expect(await driver.checkPage?.(terms, { assertCurrent() {} })).toBe(true);
    expect(port.requests).toHaveLength(0);
    // After the card: the one terms reading, bound to the click.
    expect(await driver.verifyTerms?.(terms, { assertCurrent() {} })).toBe(true);
    await driver.submitOrder('e1', { assertCurrent() {} });
    expect(port.requests).toHaveLength(1);
    expect(observations).toBe(2);
    // Once after the reading, once by the engine immediately before dispatch.
    expect(rechecks).toBe(2);
  } finally { installJudgmentPort(previous); }
});
