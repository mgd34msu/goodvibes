// Proves: A scheduled purchase under a standing authorisation exceeds its per-purchase or per-period maximum, buys another item or at another shop, or runs after the entry expired or was removed.
// Red when: `DaemonStandingAuthorizations.reserve` stops capping a purchase by what is left of the period, counts a refused purchase or forgets one still running, or admits another shop, another item, an expired entry or a removed one.
/**
 * A standing authorisation lets a scheduled run buy with nobody asked in the
 * moment, so what `reserve` allows is the only limit on it: each purchase is
 * capped by the per-purchase maximum and by what is left of the period, counted
 * from the purchases on record, and only the owner's shop and item, while the
 * entry is live, are admitted. A store opened again over the same file answers
 * the same.
 *
 * Real `DaemonStandingAuthorizations`, `DurablePaymentOperations` and the
 * daemon's use counter over a temp folder. Stand-in: the clock.
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { DurablePaymentOperations } from '../platform/src/platform/payments/host/operation-store.ts';
import { DaemonStandingAuthorizations } from '../platform/src/platform/payments/host/standing-store.ts';
import { standingUseCounter } from '../platform/src/platform/payments/host/standing-handlers.ts';
import type { PaymentOperationState } from '../platform/src/platform/payments/operation-view.ts';
import { parseCurrencyCode, type CurrencyCode } from '../platform/src/platform/payments/types.ts';

const usd = parseCurrencyCode('USD') as CurrencyCode;
const DAY = 86_400_000;

test('a purchase under a standing authorisation is held to its maximums, its shop and item, and its life', () => {
  const dir = makeProjectTempDir('gv-standing');
  let now = Date.parse('2026-11-17T12:00:00Z');
  const file = join(dir, 'payments-standing.json');
  const operations = new DurablePaymentOperations(join(dir, 'payments-operations'));
  const count = standingUseCounter(operations);
  const entry = new DaemonStandingAuthorizations(file, () => now).add({ item: 'Coffee beans, 1 kg', merchants: ['shop.example'],
    maxPerPurchase: '60', maxPerPeriod: '100', periodDays: 30, expires: '2027-06-30' }, usd);
  const reserve = (store: DaemonStandingAuthorizations, purchaseId: string, at = 'www.shop.example', item = 'coffee beans, 1 KG') =>
    store.reserve({ id: entry.id, purchaseId, merchantDomain: at, item, requestedMaxMinorUnits: undefined, currency: usd }, count);
  const cap = (result: ReturnType<typeof reserve>) => (result.ok ? result.capMinorUnits : 'refused');
  const record = (purchaseId: string, state: PaymentOperationState, totalMinorUnits: number | null) => operations.create({ purchaseId,
    operationId: `op-${purchaseId}`, state, phase: null, createdAtMs: now, updatedAtMs: now,
    outcome: state === 'completed' ? 'purchased' : null, totalMinorUnits, currency: 'USD' }, null, () => {}).release();

  const store = new DaemonStandingAuthorizations(file, () => now);
  expect(cap(reserve(store, 'p-1'))).toBe(6_000);
  record('p-1', 'completed', 5_500);
  expect(cap(reserve(store, 'p-2'))).toBe(4_500);
  record('p-2', 'refused', null);
  expect(cap(reserve(store, 'p-3'))).toBe(4_500);
  record('p-3', 'running', null);
  expect(cap(reserve(store, 'p-4'))).toBe('refused');
  // The same answers from a store opened again over the file, as after a restart.
  const reopened = new DaemonStandingAuthorizations(file, () => now);
  expect(cap(reserve(reopened, 'p-5'))).toBe('refused');

  now += 31 * DAY;
  expect(cap(reserve(reopened, 'p-6', 'other.example'))).toBe('refused');
  expect(cap(reserve(reopened, 'p-7', 'www.shop.example', 'Coffee beans, 5 kg'))).toBe('refused');
  expect(cap(reserve(reopened, 'p-8'))).toBe(6_000);

  const later = now;
  now = Date.parse('2027-07-01T00:00:00Z');
  expect(cap(reserve(reopened, 'p-9'))).toBe('refused');
  now = later;
  expect(reopened.remove(entry.id)).toBe(true);
  expect(cap(reserve(reopened, 'p-10'))).toBe('refused');
});
