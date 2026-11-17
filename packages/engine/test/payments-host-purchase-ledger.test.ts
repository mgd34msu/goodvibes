/**
 * The purchase ledger: every purchase is recorded once under its request id,
 * survives a reopen and concurrent writers in other processes, and damaged
 * history refuses rather than reading as "never bought".
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, expect, test } from 'bun:test';
import type { PurchaseRecord } from '../platform/src/platform/payments/purchase-record.js';
import { DaemonPurchaseLedger, PaymentPurchaseLedgerError } from '../platform/src/platform/payments/host/purchase-ledger.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

function purchase(overrides: Partial<PurchaseRecord> = {}): PurchaseRecord {
  return {
    purchaseId: 'pur-1',
    atUtc: '2026-08-19T10:00:00.000Z',
    dayKey: '2026-08-19',
    timezone: 'UTC',
    merchantDomain: 'example.invalid',
    item: 'a replacement kettle' as PurchaseRecord['item'],
    currency: 'USD' as PurchaseRecord['currency'],
    itemMinorUnits: 4599,
    taxMinorUnits: 380,
    feesMinorUnits: 0,
    shippingMinorUnits: 599,
    totalMinorUnits: 5578,
    shippingTierRequested: 'normal',
    shippingTierUsed: 'normal',
    steppedDown: false,
    itemPoolDraw: 4599,
    overagePoolDraw: 979,
    tolerancePoolDraw: 0,
    cardLast4: '1111',
    windowKind: 'veto',
    windowOutcome: 'proceeded',
    answeredBy: null,
    outcome: 'purchased',
    refusalReason: null,
    merchantOrderId: 'ORD-9',
    refundedAt: null,
    merchantRecognised: true,
    merchantQualifier: 'major-retailer',
    merchantDiscovered: false,
    ...overrides,
  };
}

let filePath = '';

beforeEach(() => {
  filePath = join(makeProjectTempDir('gv-payments-ledger'), 'payments-purchases.json');
});

test('real recovery lookup finds recorded submissions and keeps unverified distinct from purchased', async () => {
  const ledger = new DaemonPurchaseLedger({ filePath });
  expect(await ledger.has('absent')).toBe(false);
  await ledger.record(purchase({ purchaseId: 'unverified', outcome: 'submitted-unverified' }));
  expect(await ledger.has('unverified')).toBe(true);
  const restarted = new DaemonPurchaseLedger({ filePath });
  expect(await restarted.has('unverified')).toBe(true);
  expect(restarted.get('unverified')?.outcome).toBe('submitted-unverified');
  expect(restarted.get('absent')).toBeNull();
});

test.each(['malformed'] as const)('%s accounting is never absent and cannot be replaced by a later record', async () => {
  writeFileSync(filePath, '{bad');
  const original = readFileSync(filePath);
  const ledger = new DaemonPurchaseLedger({ filePath });
  await expect(ledger.has('absent')).rejects.toBeInstanceOf(PaymentPurchaseLedgerError);
  await expect(ledger.record(purchase())).rejects.toBeInstanceOf(PaymentPurchaseLedgerError);
  expect(readFileSync(filePath).equals(original)).toBe(true);
});

test('independent concurrent ledger writers retain every admitted purchase', async () => {
  await Promise.all(Array.from({ length: 12 }, (_, index) =>
    new DaemonPurchaseLedger({ filePath }).record(purchase({ purchaseId: `concurrent-${index}` }))));
  const rows = new DaemonPurchaseLedger({ filePath }).list({ limit: 20, dayKey: undefined });
  expect(rows.total).toBe(12); expect(new Set(rows.purchases.map(row => row.purchaseId)).size).toBe(12);
});
