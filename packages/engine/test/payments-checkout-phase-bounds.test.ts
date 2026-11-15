import { expect, test } from 'bun:test';
import { runCheckout, type CheckoutFlowDeps } from '../platform/src/platform/payments/checkout-flow.js';
import { CheckoutRegistry, CheckoutRegistryError, MemoryCheckoutJournal } from '../platform/src/platform/payments/checkout-registry.js';
import { BudgetLedger } from '../platform/src/platform/payments/budget.js';
import { CardMaterialRedactor } from '../platform/src/platform/payments/card-redaction.js';
import type { RawCheckoutReading } from '../platform/src/platform/payments/checkout-extraction.js';
import { parseCurrencyCode, unsafeOwnerSuppliedTextForTests } from '../platform/src/platform/payments/types.js';
import { UntrustedContentLedger } from '../platform/src/platform/security/untrusted-content.js';
import { usePaymentsReadings } from './helpers/payments-readings.ts';

usePaymentsReadings();
const currency = (() => { const parsed = parseCurrencyCode('USD'); if (!parsed) throw new Error('Invalid fixture currency'); return parsed; })();
const reading = (unitPrice: string): RawCheckoutReading => ({ lines: [{ label: 'Fixture item', quantity: '1', unitPrice }], tax: '$1.00', fees: [],
  shippingOptions: [{ label: 'Standard', cost: '$0.00' }], statedTotal: null, currency: 'USD', orderSummaryText: 'One fixture item' });

test('a page whose price keeps changing stops after a bounded number of new notices, with nothing submitted', async () => {
  const journal = new MemoryCheckoutJournal(), ledger = new BudgetLedger(), effects: string[] = [];
  let notices = 0, quotes = 0;
  const deps: CheckoutFlowDeps = {
    registry: new CheckoutRegistry(journal), ledger, redactor: new CardMaterialRedactor(),
    cards: { async metadata() { return null; }, async read() { effects.push('card-read'); return null; } },
    addresses: { async read() { return null; } },
    purchases: { async record() { effects.push('purchase-record'); } },
    driver: {
      identity: () => ({ sessionId: 'session', pageId: 'page' }),
      // Every verification finds the quote changed, and every re-read flips the price.
      async verifyTerms() { return false; },
      async readCurrentQuote() { return reading(++quotes % 2 ? '$11.00' : '$10.00'); },
      async url() { return 'https://www.bestbuy.com/checkout'; },
      async fill() { effects.push('fill'); },
      async fillSecrets() { effects.push('fill-secrets'); return { filledTargets: [], failedTarget: null }; },
      async choose() {},
      async submitOrder() { effects.push('submit'); return { url: 'https://www.bestbuy.com/done', orderId: null, verified: false }; },
    },
    notifier: {
      async deliver() { notices++; return [{ channel: 'tui', delivered: true, backfillable: false }]; },
      async awaitAnswer() {
        if (notices > 8) throw new Error('The checkout kept sending the owner new notices');
        return { answer: 'acknowledge', channel: 'tui' };
      },
    },
    untrusted: new UntrustedContentLedger(),
    limits: { dailyItemMinorUnits: 10_000, dailyOverageMinorUnits: 10_000, perPurchaseCeiling: { enabled: false, minorUnits: 0 }, overageTolerance: { enabled: false, dailyAllowanceMinorUnits: 0 } },
    budgetCurrency: currency, timezone: 'UTC',
    gates: { enabled: true, hasUsableCard: true, hasShippingAddress: true, isOwnerDirectRequest: true, isPaymentsLeader: true },
    approvalMinutes: 60, vetoMinutes: 10, now: Date.now,
    merchantJudge: { async judge() { return { qualifies: true, confident: true, recourse: 'Fixture returns policy' }; } },
  };
  const outcome = await runCheckout({
    purchaseId: 'moving-price', merchantDomain: 'bestbuy.com', checkoutUrl: 'https://www.bestbuy.com/checkout',
    item: unsafeOwnerSuppliedTextForTests('Fixture item'), requestedLines: [{ label: 'Fixture item', quantity: 1 }],
    cardId: 'fixture-card', preferredTier: 'normal',
  }, reading('$10.00'), { cardFields: [], shippingTargets: ['fixture-shipping'], placeOrderTarget: 'fixture-submit' }, deps);
  expect(outcome).toMatchObject({ kind: 'refused', code: 'total-changed' });
  expect(notices).toBe(4);
  expect(effects).toEqual([]);
  expect(await journal.list()).toEqual([]); expect(ledger.state().reservations).toEqual([]);
});

test('a journalled possible submission cannot be moved back to a not-submitted phase', async () => {
  const journal = new MemoryCheckoutJournal(), registry = new CheckoutRegistry(journal);
  await registry.open({ purchaseId: 'purchase', sessionId: 'session', pageId: 'page', merchantDomain: 'bestbuy.com', cardId: 'card',
    item: unsafeOwnerSuppliedTextForTests('Fixture item'), currency, phase: 'deciding', startedAtMs: 1, updatedAtMs: 1,
    draw: null, reservationId: null, shippingTierRequested: 'normal', shippingTierUsed: null, stepDown: null, totalMinorUnits: null });
  for (const phase of ['awaiting-window', 'arming-payment', 'submit-pending'] as const) await registry.advance('purchase', phase);
  const refused = registry.advance('purchase', 'arming-payment');
  await expect(refused).rejects.toBeInstanceOf(CheckoutRegistryError);
  await expect(refused).rejects.toThrow('from submit-pending it can become submitted');
  expect((await journal.list())[0]?.phase).toBe('submit-pending');
});
