/**
 * DaemonPurchaseLedger: append-only, newest first, and reconcilable.
 *
 * The interesting assertions are about what the ledger will NOT do: it exposes
 * no update and no delete, `total` counts the filter rather than the page, and a
 * row that arrived without `merchantDiscovered` reads as false rather than
 * acquiring a claim nothing observed.
 */
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'bun:test';
import type { PurchaseRecord } from '../sdk/src/platform/payments/purchase-record.js';
import { DaemonPurchaseLedger, PaymentPurchaseLedgerError, MAX_PURCHASE_LIST_LIMIT } from '../sdk/src/platform/payments/host/purchase-ledger.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { acquireCrossProcessLock } from '../sdk/src/platform/workspace/checkpoint/cross-process-lock.js';

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

describe('DaemonPurchaseLedger', () => {
  test('an absent ledger lists as empty rather than failing', () => {
    const ledger = new DaemonPurchaseLedger({ filePath });
    expect(ledger.list({ limit: 10, dayKey: undefined })).toEqual({ purchases: [], total: 0 });
  });

  test('a recorded purchase comes back whole', async () => {
    const ledger = new DaemonPurchaseLedger({ filePath });
    await ledger.record(purchase());
    const result = ledger.list({ limit: 10, dayKey: undefined });
    expect(result.total).toBe(1);
    expect(result.purchases[0]!.purchaseId).toBe('pur-1');
    expect(result.purchases[0]!.totalMinorUnits).toBe(5578);
    expect(result.purchases[0]!.cardLast4).toBe('1111');
  });

  test('a row carries no card material, only the last four digits', async () => {
    const ledger = new DaemonPurchaseLedger({ filePath });
    await ledger.record(purchase());
    const onDisk = readFileSync(filePath, 'utf-8');
    expect(onDisk).toContain('"cardLast4"');
    expect(onDisk).not.toContain('4111111111111111');
  });

  test('newest first, so a surface showing five shows the last five', async () => {
    const ledger = new DaemonPurchaseLedger({ filePath });
    for (const n of [1, 2, 3]) await ledger.record(purchase({ purchaseId: `pur-${String(n)}` }));
    const result = ledger.list({ limit: 10, dayKey: undefined });
    expect(result.purchases.map((row) => row.purchaseId)).toEqual(['pur-3', 'pur-2', 'pur-1']);
  });

  test('total counts the filter, not the page', async () => {
    const ledger = new DaemonPurchaseLedger({ filePath });
    for (const n of [1, 2, 3, 4, 5]) await ledger.record(purchase({ purchaseId: `pur-${String(n)}` }));
    const result = ledger.list({ limit: 2, dayKey: undefined });
    expect(result.purchases).toHaveLength(2);
    expect(result.total).toBe(5);
  });

  test('a dayKey filter narrows both the page and the total', async () => {
    const ledger = new DaemonPurchaseLedger({ filePath });
    await ledger.record(purchase({ purchaseId: 'pur-a', dayKey: '2026-08-18' }));
    await ledger.record(purchase({ purchaseId: 'pur-b', dayKey: '2026-08-19' }));
    await ledger.record(purchase({ purchaseId: 'pur-c', dayKey: '2026-08-19' }));
    const result = ledger.list({ limit: 10, dayKey: '2026-08-19' });
    expect(result.total).toBe(2);
    expect(result.purchases.map((row) => row.purchaseId)).toEqual(['pur-c', 'pur-b']);
  });

  test('the limit is clamped rather than trusted', async () => {
    const ledger = new DaemonPurchaseLedger({ filePath });
    await ledger.record(purchase());
    expect(ledger.list({ limit: 0, dayKey: undefined }).purchases).toHaveLength(1);
    expect(ledger.list({ limit: -5, dayKey: undefined }).purchases).toHaveLength(1);
    expect(ledger.list({ limit: MAX_PURCHASE_LIST_LIMIT * 10, dayKey: undefined }).purchases).toHaveLength(1);
  });

  test('a record with no merchantDiscovered reads as false, never as a claim', async () => {
    const ledger = new DaemonPurchaseLedger({ filePath });
    // A legacy row from before the field existed: strip it deliberately.
    const { merchantDiscovered: _dropped, ...legacy } = purchase();
    await ledger.record(legacy as PurchaseRecord);
    expect(ledger.list({ limit: 1, dayKey: undefined }).purchases[0]!.merchantDiscovered).toBe(false);
  });

  test('a record that states merchantDiscovered keeps it', async () => {
    const ledger = new DaemonPurchaseLedger({ filePath });
    await ledger.record({ ...purchase(), merchantDiscovered: true } as PurchaseRecord);
    expect(ledger.list({ limit: 1, dayKey: undefined }).purchases[0]!.merchantDiscovered).toBe(true);
  });

  test('records append: a second write never replaces the first', async () => {
    const ledger = new DaemonPurchaseLedger({ filePath });
    await ledger.record(purchase({ purchaseId: 'pur-1' }));
    await ledger.record(purchase({ purchaseId: 'pur-1', outcome: 'refunded' }));
    // Same id twice is two rows, not an edit. The row is evidence a purchase
    // happened, and evidence a later call can overwrite is not evidence.
    expect(ledger.list({ limit: 10, dayKey: undefined }).total).toBe(2);
  });

  test('a torn ledger remains present and refuses instead of reporting empty history', () => {
    const damaged = '{"version":1,"purchases":[{';
    writeFileSync(filePath, damaged);
    expect(() => new DaemonPurchaseLedger({ filePath }).list({ limit: 10, dayKey: undefined })).toThrow(PaymentPurchaseLedgerError);
    expect(readFileSync(filePath, 'utf8')).toBe(damaged);
  });

  test('a file with no purchases array is unavailable rather than empty', () => {
    writeFileSync(filePath, '{"version":1}');
    expect(() => new DaemonPurchaseLedger({ filePath }).list({ limit: 10, dayKey: undefined })).toThrow(PaymentPurchaseLedgerError);
  });

  test('a second ledger over the same path sees what the first wrote', async () => {
    await new DaemonPurchaseLedger({ filePath }).record(purchase());
    expect(new DaemonPurchaseLedger({ filePath }).list({ limit: 10, dayKey: undefined }).total).toBe(1);
  });
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

test.each(['malformed', 'unsupported', 'row', 'utf8', 'directory', 'dangling-link'] as const)('%s accounting is never absent and cannot be replaced by a later record', async kind => {
  if (kind === 'directory') mkdirSync(filePath);
  else if (kind === 'dangling-link') symlinkSync(`${filePath}.missing`, filePath);
  else writeFileSync(filePath, kind === 'malformed' ? '{bad' : kind === 'utf8' ? Buffer.from([0xff, 0xfe])
    : JSON.stringify({ version: kind === 'unsupported' ? 99 : 1, purchases: kind === 'row' ? [{ purchaseId: 'partial' }] : [] }));
  const original = kind === 'directory' || kind === 'dangling-link' ? null : readFileSync(filePath);
  const ledger = new DaemonPurchaseLedger({ filePath });
  await expect(ledger.has('absent')).rejects.toBeInstanceOf(PaymentPurchaseLedgerError);
  await expect(ledger.record(purchase())).rejects.toBeInstanceOf(PaymentPurchaseLedgerError);
  if (original) expect(readFileSync(filePath).equals(original)).toBe(true);
});

test('a ledger which disappears after observation is not reset to an unused ledger', async () => {
  const ledger = new DaemonPurchaseLedger({ filePath }); await ledger.record(purchase());
  const { unlinkSync } = await import('node:fs'); unlinkSync(filePath);
  await expect(ledger.has('pur-1')).rejects.toBeInstanceOf(PaymentPurchaseLedgerError);
  await expect(ledger.record(purchase({ purchaseId: 'pur-2' }))).rejects.toBeInstanceOf(PaymentPurchaseLedgerError);
});

test('supported unknown envelope/row fields survive appending and invalid incoming values do not poison healthy evidence', async () => {
  writeFileSync(filePath, JSON.stringify({ version: 1, purchaseFormatExtension: { retained: true }, purchases: [{ ...purchase(), futureField: ['original'] }] }));
  const ledger = new DaemonPurchaseLedger({ filePath });
  await expect(ledger.record(purchase({ totalMinorUnits: NaN }))).rejects.toMatchObject({ kind: 'invalid-record' });
  await ledger.record(purchase({ purchaseId: 'pur-2' }));
  const stored = JSON.parse(readFileSync(filePath, 'utf8'));
  expect(stored.purchaseFormatExtension).toEqual({ retained: true }); expect(stored.purchases[0].futureField).toEqual(['original']);
  expect(ledger.list({ limit: 10, dayKey: undefined }).total).toBe(2);
  expect(Object.isFrozen(ledger.get('pur-1'))).toBe(true);
});

test('record detaches the actual receipt before waiting for another writer', async () => {
  const ledger = new DaemonPurchaseLedger({ filePath }), original = purchase();
  const release = await acquireCrossProcessLock(`${filePath}.mutation.lock`, { strictOwnership: true });
  const pending = ledger.record(original); const handled = pending.catch(error => error);
  try { Reflect.set(original, 'totalMinorUnits', 999); Reflect.set(original, 'purchaseId', 'replacement'); }
  finally { release(); }
  await handled;
  expect(ledger.get('pur-1')?.totalMinorUnits).toBe(5578); expect(ledger.get('replacement')).toBeNull();
});

test('independent concurrent ledger writers retain every admitted purchase', async () => {
  await Promise.all(Array.from({ length: 12 }, (_, index) =>
    new DaemonPurchaseLedger({ filePath }).record(purchase({ purchaseId: `concurrent-${index}` }))));
  const rows = new DaemonPurchaseLedger({ filePath }).list({ limit: 20, dayKey: undefined });
  expect(rows.total).toBe(12); expect(new Set(rows.purchases.map(row => row.purchaseId)).size).toBe(12);
});

test('separate processes append through the same actual purchase mutation lock', async () => {
  const root = makeProjectTempDir('purchase-ledger-processes'), childPath = join(root, 'append.ts');
  const module = new URL('../sdk/src/platform/payments/host/purchase-ledger.ts', import.meta.url).href;
  writeFileSync(childPath, `import { DaemonPurchaseLedger } from ${JSON.stringify(module)}; await new DaemonPurchaseLedger({ filePath: process.argv[2]! }).record(JSON.parse(process.argv[3]!));`);
  const children = Array.from({ length: 4 }, (_, index) => Bun.spawn([process.execPath, 'run', childPath, filePath, JSON.stringify(purchase({ purchaseId: `process-${index}` }))], { stdout: 'pipe', stderr: 'pipe' }));
  const results = await Promise.all(children.map(async child => {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exitCode, stdout, stderr };
  }));
  for (const result of results) expect(result, result.stderr).toMatchObject({ exitCode: 0 });
  expect(new DaemonPurchaseLedger({ filePath }).list({ limit: 20, dayKey: undefined }).total).toBe(4);
});

test('unknown recorded event semantics refuse recovery rather than claiming either absence or success', async () => {
  const ledger = new DaemonPurchaseLedger({ filePath }); await ledger.record(purchase({ outcome: 'future-event' }));
  expect(ledger.list({ limit: 10, dayKey: undefined }).total).toBe(1);
  await expect(ledger.has('pur-1')).rejects.toBeInstanceOf(PaymentPurchaseLedgerError);
});
