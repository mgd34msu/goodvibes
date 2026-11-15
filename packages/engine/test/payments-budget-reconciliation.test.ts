import { expect, test } from 'bun:test';
import { BudgetLedger, type BudgetLimits, type CheckoutBudgetSettlement } from '../platform/src/platform/payments/budget.js';

const limits: BudgetLimits = { dailyItemMinorUnits: 10_000, dailyOverageMinorUnits: 2_000,
  perPurchaseCeiling: { enabled: false, minorUnits: 0 }, overageTolerance: { enabled: false, dailyAllowanceMinorUnits: 0 } };
const started = Date.parse('2026-11-07T12:00:00Z');
const DAY = 24 * 60 * 60 * 1_000;

function receipt(outcome: CheckoutBudgetSettlement['outcome'], operationId = 'op', atMs = started): CheckoutBudgetSettlement {
  return { operationId, purchaseId: 'purchase', outcome, atMs, reservation: null, spend: null };
}

test('a purchase cannot be settled as bought when neither its hold nor its spend exists', () => {
  const ledger = new BudgetLedger();
  expect(() => ledger.settleReconciliation(receipt('purchased'))).toThrow('cannot be settled as bought');
  expect(ledger.state().reconciliations).toBeUndefined();
  expect(ledger.snapshot(limits, started, 'UTC').item.spent).toBe(0);
});

test('a purchase settled as not bought with nothing to release is still recorded once', () => {
  const ledger = new BudgetLedger();
  ledger.settleReconciliation(receipt('not-purchased'));
  ledger.settleReconciliation(receipt('not-purchased'));
  expect(ledger.state().reconciliations).toHaveLength(1);
});

test('a held purchase settled as bought is charged to the budget', () => {
  const ledger = new BudgetLedger();
  const hold = ledger.reserve({ id: 'purchase', itemMinorUnits: 700, overageMinorUnits: 0, toleranceMinorUnits: 0,
    limits, nowMs: started, timezone: 'UTC', retainUntilSettled: true });
  expect(hold).not.toBeNull();
  ledger.settleReconciliation({ ...receipt('purchased'), reservation: hold });
  expect(ledger.snapshot(limits, started, 'UTC').item).toMatchObject({ spent: 700, reserved: 0 });
});

test('old settlement receipts are dropped from the snapshot but recent ones stay', () => {
  const ledger = new BudgetLedger();
  ledger.settleReconciliation(receipt('not-purchased', 'old', started));
  ledger.settleReconciliation(receipt('not-purchased', 'recent', started + 80 * DAY));
  ledger.prune(started + 100 * DAY);
  expect(ledger.state().reconciliations?.map(row => row.operationId)).toEqual(['recent']);
});
