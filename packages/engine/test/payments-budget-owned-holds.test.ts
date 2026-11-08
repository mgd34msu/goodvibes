import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BudgetLedger, RESERVATION_TTL_MS, type BudgetLimits } from '../sdk/src/platform/payments/budget.js';
import { DurableBudgetLedger, PaymentBudgetUnavailableError } from '../sdk/src/platform/payments/host/budget-store.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const limits: BudgetLimits = { dailyItemMinorUnits: 10_000, dailyOverageMinorUnits: 2_000,
  perPurchaseCeiling: { enabled: false, minorUnits: 0 }, overageTolerance: { enabled: true, dailyAllowanceMinorUnits: 1_000 } };
const started = Date.parse('2026-11-07T23:00:00Z');
const later = started + 7 * 24 * 60 * 60 * 1_000;
function path() { const root = mkdtempSync(join(tmpdir(), 'payment-held-budget-')); roots.push(root); return join(root, 'budget.json'); }
function reserve(ledger: BudgetLedger, retained = true) {
  return ledger.reserve({ id: 'purchase', itemMinorUnits: 7_000, overageMinorUnits: 300, toleranceMinorUnits: 50,
    limits, nowMs: started, timezone: 'UTC', ...(retained ? { retainUntilSettled: true as const } : {}) });
}

test('an unresolved checkout remains reserved across TTL, calendar days and sweeps in every pool', () => {
  const ledger = new BudgetLedger(); expect(reserve(ledger)).not.toBeNull();
  expect(ledger.sweep(later)).toEqual([]);
  const snapshot = ledger.snapshot(limits, later, 'UTC');
  expect(snapshot.item).toMatchObject({ spent: 0, reserved: 7_000, remaining: 3_000 });
  expect(snapshot.overage).toMatchObject({ reserved: 300, remaining: 1_700 });
  expect(snapshot.tolerance).toMatchObject({ reserved: 50, remaining: 950 });
  expect(ledger.reserve({ id: 'other', itemMinorUnits: 4_000, overageMinorUnits: 0, toleranceMinorUnits: 0,
    limits, nowMs: later, timezone: 'UTC' })).toBeNull();
  expect(ledger.release('purchase')).toBe(true);
  expect(ledger.snapshot(limits, later, 'UTC').item.remaining).toBe(10_000);
});

test('ordinary temporary holds still expire while checkout holds require settlement', () => {
  const ledger = new BudgetLedger(); reserve(ledger, false);
  expect(ledger.sweep(started + RESERVATION_TTL_MS + 1).map(entry => entry.id)).toEqual(['purchase']);
  expect(ledger.state().reservations).toEqual([]);
});

test('a protected hold survives a real durable reopen and becomes spend only on commit', () => {
  const file = path(); const first = new DurableBudgetLedger(file, () => started); reserve(first);
  const next = new DurableBudgetLedger(file, () => later);
  expect(next.sweep(later)).toEqual([]);
  expect(next.snapshot(limits, later, 'UTC').item.remaining).toBe(3_000);
  expect(next.commit('purchase', later)?.itemMinorUnits).toBe(7_000);
  const settled = new DurableBudgetLedger(file, () => later);
  expect(settled.snapshot(limits, later, 'UTC').item).toMatchObject({ reserved: 0, spent: 7_000, remaining: 3_000 });
});

test('existing version-1 holds upgrade before exposure and do not disappear after their old TTL', () => {
  const file = path(); const ordinary = new BudgetLedger(); reserve(ordinary, false);
  writeFileSync(file, JSON.stringify({ version: 1, ...ordinary.state() }));
  const restored = new DurableBudgetLedger(file, () => later);
  expect(restored.snapshot(limits, later, 'UTC').item.remaining).toBe(3_000);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  expect(saved.version).toBe(2); expect(saved.reservations[0].retainUntilSettled).toBe(true);
  expect(new DurableBudgetLedger(file, () => later).sweep(later)).toEqual([]);
});

test('neither returned reservations nor borrowed initial records can erase or shrink a hold', () => {
  const ledger = new BudgetLedger(); const held = reserve(ledger);
  if (!held) throw new Error('Fixture did not reserve');
  expect(Reflect.set(held, 'retainUntilSettled', undefined)).toBe(false);
  expect(Reflect.set(held, 'itemMinorUnits', 0)).toBe(false);
  const initial = { ...held }; const restored = new BudgetLedger({ spend: [], reservations: [initial] });
  initial.itemMinorUnits = 0; delete initial.retainUntilSettled;
  expect(restored.snapshot(limits, later, 'UTC').item.reserved).toBe(7_000);
});

test.each([0.5, -1, Number.MAX_SAFE_INTEGER + 1])('invalid stored minor units %s block accounting instead of discarding unknown spend', value => {
  const file = path(); const raw = JSON.stringify({ version: 2, spend: [{ purchaseId: 'bad', atMs: started,
    itemMinorUnits: value, overageMinorUnits: 0, toleranceMinorUnits: 0 }], reservations: [] });
  writeFileSync(file, raw); const ledger = new DurableBudgetLedger(file, () => later);
  expect(() => ledger.snapshot(limits, later, 'UTC')).toThrow(PaymentBudgetUnavailableError);
  expect(readFileSync(file, 'utf8')).toBe(raw);
});

test('a duplicate stored reservation cannot be partially released into a different balance', () => {
  const file = path(); const ordinary = new BudgetLedger(); const held = reserve(ordinary);
  writeFileSync(file, JSON.stringify({ version: 2, spend: [], reservations: [held, held] }));
  const ledger = new DurableBudgetLedger(file, () => later);
  expect(() => ledger.release('purchase')).toThrow(PaymentBudgetUnavailableError);
});

test('a committed purchase ID cannot take another reservation from the retained accounting history', () => {
  const ledger = new BudgetLedger(); reserve(ledger); ledger.commit('purchase', started);
  expect(reserve(ledger)).toBeNull();
  expect(ledger.state().spend).toHaveLength(1);
});
