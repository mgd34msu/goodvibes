// Proves: After a crash at the point of submitting, a checkout that may have been submitted has its hold released and its record closed, one that never submitted keeps holding money, or the owner's finding on it settles the hold the wrong way or twice.
// Red when: Start-up recovery releases a hold on anything but a checkout that never submitted, keeps one that never submitted, settles before the owner was told, or the owner's finding turns the hold into spend the wrong way.
/**
 * What the daemon does at start-up with the checkouts a crash left behind,
 * and with the owner's later finding on the one nobody can be sure of. A
 * checkout that never submitted gives its money back and its record goes; one
 * that may have reached the merchant keeps its money held and its record, and
 * the owner is told to check the shop; one already on the purchase ledger
 * becomes spend. Nothing settles until the owner has been told. The owner's
 * "bought" turns the hold into spend, "not bought" frees it.
 *
 * Real `CheckoutRegistry`, `DurableCheckoutJournal`, `DurableBudgetLedger`,
 * `DaemonPurchaseLedger`, `DurablePaymentOperations`, `CheckoutRecovery` and
 * `PurchaseReconciliations` over one temp folder, wired as the payment host
 * wires them; each start is a new set of objects over the same files.
 * Stand-in: the notifier, which records what the owner was told.
 */
import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import type { BudgetLimits } from '../platform/src/platform/payments/budget.ts';
import { CheckoutRecovery } from '../platform/src/platform/payments/checkout-recovery.ts';
import { CheckoutRegistry, type InFlightCheckout } from '../platform/src/platform/payments/checkout-registry.ts';
import { DurableBudgetLedger } from '../platform/src/platform/payments/host/budget-store.ts';
import { DurableCheckoutJournal } from '../platform/src/platform/payments/host/checkout-journal-store.ts';
import { DurablePaymentOperations } from '../platform/src/platform/payments/host/operation-store.ts';
import { DaemonPurchaseLedger } from '../platform/src/platform/payments/host/purchase-ledger.ts';
import { PurchaseReconciliations } from '../platform/src/platform/payments/host/purchase-reconciliation.ts';
import type { PaymentNotifier } from '../platform/src/platform/payments/payment-ports.ts';
import type { PaymentOperationState } from '../platform/src/platform/payments/operation-view.ts';
import type { PurchaseRecord } from '../platform/src/platform/payments/purchase-record.ts';
import { parseCurrencyCode, unsafeOwnerSuppliedTextForTests, type CurrencyCode } from '../platform/src/platform/payments/types.ts';

const usd = parseCurrencyCode('USD') as CurrencyCode;
const NOW = Date.parse('2026-11-17T12:00:00Z');
const LIMITS: BudgetLimits = { dailyItemMinorUnits: 100_000, dailyOverageMinorUnits: 10_000,
  perPurchaseCeiling: { enabled: false, minorUnits: 0 }, overageTolerance: { enabled: false, dailyAllowanceMinorUnits: 0 } };
const DRAW = { itemMinorUnits: 4_000, overageMinorUnits: 500, toleranceMinorUnits: 0, totalMinorUnits: 4_500 };

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

/** One start of the daemon's payment host over the files in `dir`. */
function start(dir: string, delivered = true) {
  const told: string[] = [];
  const notifier: PaymentNotifier = {
    deliver: async input => { told.push(input.message); return [{ channel: 'tui', delivered, backfillable: false }]; },
    awaitAnswer: async () => null,
  };
  const journal = new DurableCheckoutJournal(join(dir, 'payments-checkout-journal.json'));
  const budget = new DurableBudgetLedger(join(dir, 'payments-budget.json'), () => NOW);
  const purchases = new DaemonPurchaseLedger({ filePath: join(dir, 'payments-purchases.json') });
  const operations = new DurablePaymentOperations(join(dir, 'payments-operations'));
  const recovery = new CheckoutRecovery({ registry: new CheckoutRegistry(journal), journal, ledger: budget, purchases, notifier,
    retainInterrupted: id => operations.retainRecovery(id), isPaymentsLeader: () => true, now: () => NOW });
  const reconciliations = new PurchaseReconciliations({ operations, journal, purchases, budget, isPaymentsLeader: () => true, now: () => NOW });
  closers.push(() => recovery.close(), () => reconciliations.close());
  const held = () => budget.state().reservations.map(row => row.id).sort();
  const spent = () => budget.state().spend.map(row => row.purchaseId).sort();
  const recorded = async () => (await journal.list()).map(row => row.purchaseId).sort();
  return { told, journal, budget, purchases, operations, recovery, reconciliations, held, spent, recorded };
}

/** What the first daemon left when it crashed: the journal record, its hold and its operation. */
async function leftBehind(host: ReturnType<typeof start>, purchaseId: string, phase: InFlightCheckout['phase'], state: PaymentOperationState) {
  expect(host.budget.reserve({ id: purchaseId, ...DRAW, limits: LIMITS, nowMs: NOW, timezone: 'UTC', retainUntilSettled: true })).not.toBeNull();
  await host.journal.put({ purchaseId, sessionId: `session-${purchaseId}`, pageId: 'page-1', merchantDomain: 'shop.example', cardId: 'card-1',
    item: unsafeOwnerSuppliedTextForTests('Kettle'), currency: usd, phase, startedAtMs: NOW - 60_000, updatedAtMs: NOW - 30_000,
    draw: DRAW, reservationId: purchaseId, shippingTierRequested: 'normal', shippingTierUsed: 'normal', stepDown: null, totalMinorUnits: DRAW.totalMinorUnits });
  host.operations.create({ purchaseId, operationId: `op-${purchaseId}`, state, phase: phase === 'deciding' ? 'deciding' : phase,
    createdAtMs: NOW - 60_000, updatedAtMs: NOW - 30_000, outcome: null, totalMinorUnits: DRAW.totalMinorUnits, currency: 'USD' }, null, () => {}).release();
}

function purchaseRecord(purchaseId: string): PurchaseRecord {
  return { purchaseId, atUtc: new Date(NOW - 30_000).toISOString(), dayKey: '2026-11-17', timezone: 'UTC', merchantDomain: 'shop.example',
    item: unsafeOwnerSuppliedTextForTests('Kettle'), currency: usd, itemMinorUnits: 4_000, taxMinorUnits: 300, feesMinorUnits: 0,
    shippingMinorUnits: 200, totalMinorUnits: DRAW.totalMinorUnits, shippingTierRequested: 'normal', shippingTierUsed: 'normal', steppedDown: false,
    itemPoolDraw: DRAW.itemMinorUnits, overagePoolDraw: DRAW.overageMinorUnits, tolerancePoolDraw: 0, cardLast4: '1111', windowKind: 'veto',
    windowOutcome: 'proceeding-silent', answeredBy: null, outcome: 'submitted-unverified', refusalReason: null, merchantOrderId: null,
    refundedAt: null, merchantRecognised: true, merchantQualifier: 'major-retailer', merchantDiscovered: false } as PurchaseRecord;
}

test('at start-up only a checkout that never submitted gives its money back, and only once the owner has been told', async () => {
  const dir = makeProjectTempDir('gv-payments-crash');
  const crashed = start(dir);
  await leftBehind(crashed, 'p-window', 'awaiting-window', 'running');
  await leftBehind(crashed, 'p-submit', 'submit-pending', 'running');
  await leftBehind(crashed, 'p-recorded', 'submit-pending', 'running');
  await crashed.purchases.record(purchaseRecord('p-recorded'));

  // A start whose notice does not reach the owner settles nothing.
  const unheard = start(dir, false);
  await unheard.recovery.recoverInterruptedCheckouts();
  expect(unheard.held()).toEqual(['p-recorded', 'p-submit', 'p-window']);
  expect(await unheard.recorded()).toEqual(['p-recorded', 'p-submit', 'p-window']);
  await unheard.recovery.close();

  const next = start(dir);
  await next.recovery.recoverInterruptedCheckouts();
  expect(next.held()).toEqual(['p-submit']);
  expect(next.spent()).toEqual(['p-recorded']);
  expect(await next.recorded()).toEqual(['p-submit']);
  expect(next.told.some(message => message.includes('Check your order history at shop.example'))).toBe(true);
  const after = start(dir);
  expect(after.budget.snapshot(LIMITS, NOW, 'UTC').item).toMatchObject({ reserved: 4_000, spent: 4_000 });
});

test('the owner\'s finding on a checkout that may have been submitted settles its hold the way the owner found it', async () => {
  for (const finding of ['purchased', 'not-purchased'] as const) {
    const dir = makeProjectTempDir('gv-payments-reconcile');
    await leftBehind(start(dir), 'p-submit', 'submit-pending', 'uncertain');
    const owner = start(dir);
    await owner.reconciliations.reconcile('p-submit', 'op-p-submit', finding, 'local-owner', () => {});
    const settled = start(dir);
    expect(`${finding}: held ${settled.held().join(',')}; spent ${settled.spent().join(',')}`)
      .toBe(`${finding}: held ; spent ${finding === 'purchased' ? 'p-submit' : ''}`);
    expect(settled.budget.snapshot(LIMITS, NOW, 'UTC').item).toMatchObject({ reserved: 0, spent: finding === 'purchased' ? 4_000 : 0 });
    expect(await settled.recorded()).toEqual([]);
  }
});
