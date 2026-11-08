import { expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { PaymentReplyInbox, PaymentReplyInboxClosedError, PaymentReplyWindowError } from '../sdk/src/platform/payments/reply-inbox.js';
import { createChannelPaymentNotifier } from '../sdk/src/platform/payments/notice-delivery.js';
import { runCheckout, type CheckoutFlowDeps } from '../sdk/src/platform/payments/checkout-flow.js';
import { CheckoutRegistry, MemoryCheckoutJournal } from '../sdk/src/platform/payments/checkout-registry.js';
import { BudgetLedger } from '../sdk/src/platform/payments/budget.js';
import { CardMaterialRedactor } from '../sdk/src/platform/payments/card-redaction.js';
import { parseCurrencyCode, unsafeOwnerSuppliedTextForTests } from '../sdk/src/platform/payments/types.js';
import { UntrustedContentLedger } from '../sdk/src/platform/security/untrusted-content.js';
import { usePaymentsReadings } from './helpers/payments-readings.ts';

usePaymentsReadings();

function checkoutFixture(signal?: AbortSignal) {
  const currency = parseCurrencyCode('USD');
  if (currency === null) throw new Error('Invalid fixture currency');
  const inbox = new PaymentReplyInbox();
  const journal = new MemoryCheckoutJournal();
  const registry = new CheckoutRegistry(journal);
  const outward: string[] = [];
  const delivered: string[] = [];
  const notifier = createChannelPaymentNotifier({
    router: { async deliver(request) { delivered.push((request as { content: string }).content); return 'fixture-delivery'; } },
    targets: [{ channel: 'telegram', request: {}, backfillable: true }],
    replies: inbox,
  });
  let windowOpened!: () => void;
  const opened = new Promise<void>((resolve) => { windowOpened = resolve; });
  const deps: CheckoutFlowDeps = {
    signal,
    registry, ledger: new BudgetLedger(), redactor: new CardMaterialRedactor(),
    cards: { async metadata() { return null; }, async read() { outward.push('card-read'); throw new Error('Card access must not occur'); } },
    addresses: { async read() { return null; } },
    purchases: { async record() { outward.push('purchase-record'); } },
    driver: {
      identity: () => ({ sessionId: 'fixture-session', pageId: 'fixture-page' }),
      async url() { return 'https://www.bestbuy.com/checkout'; },
      async fill() { outward.push('fill'); },
      async fillSecrets() { outward.push('fill-secrets'); return { filledTargets: [], failedTarget: null }; },
      async choose() { outward.push('choose'); },
      async submitOrder() { outward.push('submit'); return { url: 'https://www.bestbuy.com/done', orderId: null, verified: false }; },
    },
    notifier: {
      deliver: (input) => notifier.deliver(input),
      awaitAnswer(input) {
        expect(input.kind).toBe('veto');
        const waiting = notifier.awaitAnswer(input);
        windowOpened();
        return waiting;
      },
    },
    untrusted: new UntrustedContentLedger(),
    limits: { dailyItemMinorUnits: 10_000, dailyOverageMinorUnits: 10_000, perPurchaseCeiling: { enabled: false, minorUnits: 0 }, overageTolerance: { enabled: false, dailyAllowanceMinorUnits: 0 } },
    budgetCurrency: currency, timezone: 'UTC',
    gates: { enabled: true, hasUsableCard: true, hasShippingAddress: true, isOwnerDirectRequest: true, isPaymentsLeader: true },
    approvalMinutes: 60, vetoMinutes: 10, now: Date.now,
    merchantJudge: { async judge() { return { qualifies: true, confident: true, recourse: 'Fixture returns policy' }; } },
  };
  const purchase = runCheckout({
    purchaseId: 'shutdown-veto', merchantDomain: 'bestbuy.com', checkoutUrl: 'https://www.bestbuy.com/checkout',
    item: unsafeOwnerSuppliedTextForTests('Fixture item'), requestedLines: [{ label: 'Fixture item', quantity: 1 }],
    cardId: 'fixture-card', preferredTier: 'normal',
  }, {
    lines: [{ label: 'Fixture item', quantity: '1', unitPrice: '$10.00' }], tax: '$1.00', fees: [],
    shippingOptions: [{ label: 'Standard', cost: '$0.00' }], statedTotal: '$11.00', currency: 'USD', orderSummaryText: 'One fixture item',
  }, { cardFields: [], shippingTargets: ['fixture-shipping'], placeOrderTarget: 'fixture-submit' }, deps);
  // Observe an unexpected early failure without allowing it to become unhandled.
  void purchase.catch(() => {});
  return { inbox, journal, outward, delivered, opened, deps, purchase };
}

test('closing an active delivered veto aborts real checkout before card access or submit', async () => {
  const { inbox, journal, outward, delivered, opened, deps, purchase } = checkoutFixture();
  try {
    await Promise.race([opened, purchase.then(() => { throw new Error('Checkout never opened its veto window'); })]);
    expect(inbox.pending).toBe(1);
    expect(delivered).toHaveLength(1);
    expect((await journal.list())[0]?.phase).toBe('awaiting-window');
    await inbox.close();
    await expect(purchase).rejects.toBeInstanceOf(PaymentReplyInboxClosedError);
    expect(outward).toEqual([]);
    // This is a known pre-submit cancellation. It releases the reservation and
    // closes the window rather than retaining an ambiguous submit record.
    expect(await journal.list()).toEqual([]);
    expect(deps.ledger.snapshot(deps.limits, Date.now(), deps.timezone).item.remaining).toBe(10_000);
  } finally {
    await inbox.close();
  }
});

test('the original checkout signal cancels its veto, releases the hold and never accesses card material', async () => {
  const owner = new AbortController();
  const { inbox, journal, outward, opened, deps, purchase } = checkoutFixture(owner.signal);
  try {
    await Promise.race([opened, purchase.then(() => { throw new Error('Checkout never opened its veto window'); })]);
    owner.abort();
    await expect(purchase).rejects.toMatchObject({ kind: 'cancelled' });
    expect(outward).toEqual([]);
    expect(await journal.list()).toEqual([]);
    expect(deps.ledger.snapshot(deps.limits, Date.now(), deps.timezone).item.remaining).toBe(10_000);
  } finally { await inbox.close(); }
});

test('decision-model exhaustion while reading an owner veto cannot later buy on silence', async () => {
  const { inbox, journal, outward, opened, deps, purchase } = checkoutFixture();
  let previous: ReturnType<typeof installJudgmentPort>;
  let replaced = false;
  try {
    await Promise.race([opened, purchase.then(() => { throw new Error('Checkout never opened its veto window'); })]);
    previous = installJudgmentPort({ model: 'fixture-unavailable', async ask() { throw new JudgmentError('unavailable', 'No decision models are available'); } });
    replaced = true;
    await expect(inbox.offer('telegram', 'stop')).rejects.toBeInstanceOf(JudgmentError);
    await expect(purchase).rejects.toBeInstanceOf(PaymentReplyWindowError);
    await expect(purchase).rejects.toMatchObject({ kind: 'reading-failed' });
    expect(inbox.pending).toBe(0);
    expect(outward).toEqual([]);
    expect(await journal.list()).toEqual([]);
    expect(deps.ledger.snapshot(deps.limits, Date.now(), deps.timezone).item.remaining).toBe(10_000);
  } finally {
    await inbox.close();
    if (replaced) installJudgmentPort(previous);
  }
});
