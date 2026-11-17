/**
 * The daemon's budget ledger on disk: a hold or a spend taken through one
 * ledger is what a second ledger over the same file sees, so a restart never
 * hands back money already held or spent. Damaged accounting refuses rather
 * than reading as an empty day. A disk that refuses a write never turns a
 * charge into an error, and never leaves a reservation the caller was told failed.
 *
 * Two real `DurableBudgetLedger` handles on one file; the disk failure is a real
 * one (the ledger's folder made read-only), not a replaced function.
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';
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
afterEach(() => chmodSync(dir, 0o700));

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

test('a hold taken by one ledger is held by a second ledger over the same file', () => {
  const first = new DurableBudgetLedger(filePath, clock);
  expect(reserve(first, 'pur-1', 3_000)).not.toBeNull();
  const second = new DurableBudgetLedger(filePath, clock);
  const snapshot = second.snapshot(LIMITS, LATER, 'UTC');
  expect(snapshot.item.reserved).toBe(3_000);
  expect(snapshot.item.remaining).toBe(7_000);
  expect(reserve(second, 'pur-2', 7_001)).toBeNull();
});

test('a commit is spent and a release is free again, exactly, after reopening', () => {
  const first = new DurableBudgetLedger(filePath, clock);
  expect(reserve(first, 'spent', 4_000)).not.toBeNull();
  expect(reserve(first, 'released', 5_000)).not.toBeNull();
  expect(first.release('released')).toBe(true);
  expect(first.commit('spent', NOON + 60_000)?.itemMinorUnits).toBe(4_000);
  const second = new DurableBudgetLedger(filePath, clock);
  expect(second.snapshot(LIMITS, LATER, 'UTC').item).toMatchObject({ spent: 4_000, reserved: 0, remaining: 6_000 });
  expect(second.commit('spent', LATER)).toBeNull();
});

test.each([
  ['torn JSON', '{"version":1,"spend":[{"purchaseId":'],
  ['not a ledger', '"not budget state"'],
  ['unknown version', '{"version":99,"spend":[],"reservations":[]}'],
  ['negative spend', '{"version":1,"spend":[{"purchaseId":"p","atMs":1,"itemMinorUnits":-500,"overageMinorUnits":0,"toleranceMinorUnits":0}],"reservations":[]}'],
  ['infinite spend', '{"version":1,"spend":[{"purchaseId":"p","atMs":1,"itemMinorUnits":1e999,"overageMinorUnits":0,"toleranceMinorUnits":0}],"reservations":[]}'],
  ['negative hold', '{"version":1,"spend":[],"reservations":[{"id":"p","dayKey":"2026-08-19","itemMinorUnits":-1,"overageMinorUnits":0,"toleranceMinorUnits":0,"createdAtMs":1,"expiresAtMs":999999999999}]}'],
  ['infinite hold', '{"version":1,"spend":[],"reservations":[{"id":"p","dayKey":"2026-08-19","itemMinorUnits":1e999,"overageMinorUnits":0,"toleranceMinorUnits":0,"createdAtMs":1,"expiresAtMs":999999999999}]}'],
  ['infinite spend time', '{"version":1,"spend":[{"purchaseId":"p","atMs":1e999,"itemMinorUnits":500,"overageMinorUnits":0,"toleranceMinorUnits":0}],"reservations":[]}'],
  ['spend time past Date', '{"version":1,"spend":[{"purchaseId":"p","atMs":1e18,"itemMinorUnits":500,"overageMinorUnits":0,"toleranceMinorUnits":0}],"reservations":[]}'],
  ['hold expiry past Date', '{"version":1,"spend":[],"reservations":[{"id":"p","dayKey":"2026-08-19","itemMinorUnits":1,"overageMinorUnits":0,"toleranceMinorUnits":0,"createdAtMs":1,"expiresAtMs":1e18}]}'],
])('damaged accounting (%s) funds nothing and is left as it was', (_name, raw) => {
  writeFileSync(filePath, raw);
  expectUnavailable(new DurableBudgetLedger(filePath, clock));
});

test('repaired accounting is read only by a new ledger, never adopted by the one that refused it', () => {
  writeFileSync(filePath, 'not json at all {{{');
  const ledger = new DurableBudgetLedger(filePath, clock);
  expectUnavailable(ledger);
  writeFileSync(filePath, JSON.stringify({ version: 2, spend: [{ purchaseId: 'known-spend', atMs: LATER,
    itemMinorUnits: 3_000, overageMinorUnits: 0, toleranceMinorUnits: 0 }], reservations: [] }));
  expect(() => ledger.snapshot(LIMITS, LATER, 'UTC')).toThrow(PaymentBudgetUnavailableError);
  expect(new DurableBudgetLedger(filePath, clock).snapshot(LIMITS, LATER, 'UTC').item.remaining).toBe(7_000);
});

test('a commit the disk refuses still counts as spent, and reaches the file on the next change', () => {
  const ledger = new DurableBudgetLedger(filePath, clock);
  expect(reserve(ledger, 'pur-1', 3_000)).not.toBeNull();
  chmodSync(dir, 0o500);
  expect(ledger.commit('pur-1', NOON)).not.toBeNull();
  expect(ledger.snapshot(LIMITS, LATER, 'UTC').item).toMatchObject({ spent: 3_000, reserved: 0 });
  chmodSync(dir, 0o700);
  expect(reserve(ledger, 'pur-2', 1_000)).not.toBeNull();
  const reopened = new DurableBudgetLedger(filePath, clock);
  expect(reopened.snapshot(LIMITS, LATER, 'UTC').item).toMatchObject({ spent: 3_000, reserved: 1_000, remaining: 6_000 });
});

test('a reservation the disk refuses throws and holds nothing', () => {
  const ledger = new DurableBudgetLedger(filePath, clock);
  chmodSync(dir, 0o500);
  expect(() => reserve(ledger, 'pur-1', 3_000)).toThrow();
  chmodSync(dir, 0o700);
  expect(ledger.snapshot(LIMITS, LATER, 'UTC').item.remaining).toBe(10_000);
});
