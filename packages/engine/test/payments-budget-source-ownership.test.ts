/** Only the admitted writer may advance its selected physical budget source. */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, linkSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableBudgetLedger, PaymentBudgetUnavailableError } from '../platform/src/platform/payments/host/budget-store.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const NOW = Date.parse('2026-11-08T16:00:00Z');
const limits = { dailyItemMinorUnits: 10_000, dailyOverageMinorUnits: 1000,
  perPurchaseCeiling: { enabled: false, minorUnits: 0 }, overageTolerance: { enabled: false, dailyAllowanceMinorUnits: 0 } };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'payment-budget-source-')); roots.push(root);
  const path = join(root, 'budget.json'), ledger = new DurableBudgetLedger(path, () => NOW);
  const reserve = (id: string) => ledger.reserve({ id, itemMinorUnits: 2000, overageMinorUnits: 0, toleranceMinorUnits: 0,
    limits, nowMs: NOW, timezone: 'UTC', retainUntilSettled: true });
  return { root, path, ledger, reserve };
}

test.each(['rename', 'rewrite', 'delete', 'symlink', 'hardlink'] as const)('a %s replacement cannot be overwritten by an earlier in-memory budget owner', action => {
  const f = fixture(); expect(f.reserve('original-checkout')).not.toBeNull();
  const original = readFileSync(f.path), other = join(f.root, 'replacement.json');
  if (action === 'rename') { writeFileSync(other, original); renameSync(other, f.path); }
  if (action === 'rewrite') writeFileSync(f.path, original);
  if (action === 'delete') unlinkSync(f.path);
  if (action === 'symlink') { writeFileSync(other, original); unlinkSync(f.path); symlinkSync(other, f.path); }
  if (action === 'hardlink') linkSync(f.path, other);
  expect(() => f.ledger.state()).toThrow(PaymentBudgetUnavailableError);
  expect(() => f.ledger.snapshot(limits, NOW, 'UTC')).toThrow(PaymentBudgetUnavailableError);
  expect(() => f.reserve('another-checkout')).toThrow(PaymentBudgetUnavailableError);
  expect(() => f.ledger.release('original-checkout')).toThrow(PaymentBudgetUnavailableError);
  expect(() => f.ledger.commit('original-checkout', NOW)).toThrow(PaymentBudgetUnavailableError);
  expect(() => f.ledger.flush()).toThrow(PaymentBudgetUnavailableError);
  if (action === 'delete') expect(existsSync(f.path)).toBe(false);
  else expect(readFileSync(f.path)).toEqual(original);
});

test('an unused budget owner cannot overwrite accounting created after it observed absence', () => {
  const f = fixture(), foreign = `${JSON.stringify({ version: 2, spend: [{ purchaseId: 'another-host-order', atMs: NOW,
    itemMinorUnits: 9000, overageMinorUnits: 0, toleranceMinorUnits: 0 }], reservations: [] })}\n`;
  writeFileSync(f.path, foreign);
  expect(() => f.reserve('my-checkout')).toThrow(PaymentBudgetUnavailableError);
  expect(readFileSync(f.path, 'utf8')).toBe(foreign);
});

test('only the writer’s own published accounting advances its captured physical source', () => {
  const f = fixture();
  expect(f.reserve('first')).not.toBeNull(); expect(f.reserve('second')).not.toBeNull();
  expect(f.ledger.commit('first', NOW)?.purchaseId).toBe('first');
  expect(f.ledger.release('second')).toBe(true);
  f.ledger.flush();
  expect(f.ledger.state().spend).toHaveLength(1);
  expect(f.ledger.state().reservations).toHaveLength(0);
  const restarted = new DurableBudgetLedger(f.path, () => NOW);
  expect(restarted.state()).toEqual(f.ledger.state());
});

test('a native format publisher cannot replace the budget source between the owner check and atomic publication', () => {
  const f = fixture(); f.reserve('original-checkout');
  const original = readFileSync(f.path), replacement = join(f.root, 'replacement.json');
  let armed = false;
  const ledger = new DurableBudgetLedger(f.path, () => NOW, () => {
    if (!armed) return;
    armed = false; writeFileSync(replacement, original); renameSync(replacement, f.path);
  });
  armed = true;
  expect(() => ledger.flush()).toThrow(PaymentBudgetUnavailableError);
  expect(readFileSync(f.path)).toEqual(original);
});

test('known native purchase/operation history makes a missing budget unavailable instead of resetting spending', () => {
  const f = fixture();
  const ledger = new DurableBudgetLedger(f.path, () => NOW, undefined, undefined, undefined, () => true);
  expect(() => ledger.state()).toThrow(PaymentBudgetUnavailableError);
  expect(() => ledger.reserve({ id: 'fresh-order', itemMinorUnits: 1, overageMinorUnits: 0, toleranceMinorUnits: 0,
    limits, nowMs: NOW, timezone: 'UTC' })).toThrow(PaymentBudgetUnavailableError);
  expect(existsSync(f.path)).toBe(false);
});
