// Proves: A damaged budget file is read as an empty day, which hands the whole daily budget back.
// Red when: A parse failure is caught and treated as no spend: the snapshot answers instead of refusing, or the file is rewritten.
// Proves: Money held for an unresolved checkout is handed back by a restart, a day change or a sweep, so the day's budget is overspent.
// Red when: The durable ledger drops the hold-until-settled mark on write or sweeps the hold after its ordinary lifetime: a week later the reopened ledger shows the full budget, or the commit does not become spend.
/**
 * The daemon's budget ledger on disk: a hold taken through one ledger is what
 * a second ledger over the same file sees a week later, so a restart never
 * hands back money already held. Damaged accounting refuses rather than
 * reading as an empty day.
 *
 * Real `DurableBudgetLedger` handles on one file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'bun:test';
import type { BudgetLimits } from '../platform/src/platform/payments/budget.js';
import { DurableBudgetLedger, PaymentBudgetUnavailableError } from '../platform/src/platform/payments/host/budget-store.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const LIMITS: BudgetLimits = {
  dailyItemMinorUnits: 10_000,
  dailyOverageMinorUnits: 2_000,
  perPurchaseCeiling: { enabled: false, minorUnits: 0 },
  overageTolerance: { enabled: false, dailyAllowanceMinorUnits: 0 },
};
const NOON = Date.parse('2026-08-19T12:00:00.000Z');
const LATER = Date.parse('2026-08-19T15:00:00.000Z');
const clock = () => LATER;

let dir: string;
let filePath: string;
beforeEach(() => {
  dir = makeProjectTempDir('gv-budget-store');
  filePath = join(dir, 'payments-budget.json');
});

function reserve(ledger: DurableBudgetLedger, id: string, itemMinorUnits: number) {
  return ledger.reserve({ id, itemMinorUnits, overageMinorUnits: 0, toleranceMinorUnits: 0, limits: LIMITS, nowMs: NOON, timezone: 'UTC' });
}

/** Nothing can be read from or charged against the ledger, and the file is untouched. */
function expectUnavailable(ledger: DurableBudgetLedger): void {
  const original = readFileSync(filePath, 'utf8');
  expect(() => ledger.snapshot(LIMITS, LATER, 'UTC')).toThrow(PaymentBudgetUnavailableError);
  expect(() => ledger.state()).toThrow(PaymentBudgetUnavailableError);
  expect(() => reserve(ledger, 'unavailable', 1)).toThrow(PaymentBudgetUnavailableError);
  expect(() => ledger.release('unavailable')).toThrow(PaymentBudgetUnavailableError);
  expect(() => ledger.sweep(LATER)).toThrow(PaymentBudgetUnavailableError);
  expect(readFileSync(filePath, 'utf8')).toBe(original);
}

test.each([
  ['torn JSON', '{"version":1,"spend":[{"purchaseId":'],
])('damaged accounting (%s) funds nothing and is left as it was', (_name, raw) => {
  writeFileSync(filePath, raw);
  expectUnavailable(new DurableBudgetLedger(filePath, clock));
});

describe('a hold for a checkout not yet settled', () => {
  const limits: BudgetLimits = { dailyItemMinorUnits: 10_000, dailyOverageMinorUnits: 2_000,
    perPurchaseCeiling: { enabled: false, minorUnits: 0 }, overageTolerance: { enabled: true, dailyAllowanceMinorUnits: 1_000 } };
  const started = Date.parse('2026-11-07T23:00:00Z');
  const later = started + 7 * 24 * 60 * 60 * 1_000;
  const path = () => filePath;
  function reserve(ledger: DurableBudgetLedger) {
    return ledger.reserve({ id: 'purchase', itemMinorUnits: 7_000, overageMinorUnits: 300, toleranceMinorUnits: 50,
      limits, nowMs: started, timezone: 'UTC', retainUntilSettled: true });
  }

  test('a protected hold survives a real durable reopen and becomes spend only on commit', () => {
    const file = path(); const first = new DurableBudgetLedger(file, () => started); reserve(first);
    const next = new DurableBudgetLedger(file, () => later);
    expect(next.sweep(later)).toEqual([]);
    expect(next.snapshot(limits, later, 'UTC').item.remaining).toBe(3_000);
    expect(next.commit('purchase', later)?.itemMinorUnits).toBe(7_000);
    const settled = new DurableBudgetLedger(file, () => later);
    expect(settled.snapshot(limits, later, 'UTC').item).toMatchObject({ reserved: 0, spent: 7_000, remaining: 3_000 });
  });
});
