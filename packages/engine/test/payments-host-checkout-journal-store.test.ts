/**
 * DurableCheckoutJournal: the property under test is durability with opaque
 * cargo. A `submit-pending` record written before a crash must come back
 * byte-faithfully after a restart (that record is the one thing that lets a
 * restart say "this purchase may already have been submitted"), fields this
 * build has never heard of must round-trip untouched (the 2.0.20 repin's
 * recovery reads what its writer put here, not what this file knew to keep),
 * and damaged evidence must refuse checkout storage without being discarded
 * or taking down construction of unrelated daemon capabilities.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, symlinkSync, linkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'bun:test';
import type { InFlightCheckout } from '../platform/src/platform/payments/checkout-registry.js';
import { DurableCheckoutJournal, PaymentCheckoutJournalUnavailableError } from '../platform/src/platform/payments/host/checkout-journal-store.js';
import { CheckoutRegistry } from '../platform/src/platform/payments/checkout-registry.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

function record(overrides: Partial<InFlightCheckout> = {}): InFlightCheckout {
  return {
    purchaseId: 'pur-journal-1',
    sessionId: 'session-1',
    pageId: 'page-1',
    merchantDomain: 'example.invalid',
    cardId: 'card-1',
    item: 'a replacement kettle' as InFlightCheckout['item'],
    currency: 'USD' as InFlightCheckout['currency'],
    phase: 'submit-pending',
    startedAtMs: 1_766_000_000_000,
    updatedAtMs: 1_766_000_060_000,
    draw: null,
    reservationId: 'res-1',
    shippingTierRequested: 'normal',
    shippingTierUsed: 'normal',
    stepDown: null,
    totalMinorUnits: 5578,
    ...overrides,
  };
}

let dir = '';
let filePath = '';

beforeEach(() => {
  dir = makeProjectTempDir('gv-checkout-journal');
  filePath = join(dir, 'payments-checkout-journal.json');
});

test('the exact window notice and native delivery receipt survive real journal reopening', async () => {
  const notice = 'Approval needed: the full total exceeds your requested maximum.\nTOTAL: USD 55.78\nRequested maximum: USD 50.00';
  const receipt = { surfaceKind: 'telegram' as const, conversationId: '-100123', messageId: '51', threadId: '7', accountId: '123' };
  const original = record({ phase: 'awaiting-window', windowKind: 'approval', windowDeadlineMs: 1_766_003_660_000,
    windowNotice: notice, windowDeliveries: [{ channel: 'telegram', delivered: true, backfillable: false, receipt }] });
  const journal = new DurableCheckoutJournal(filePath);
  await journal.put(original); receipt.messageId = 'replacement';
  const restored = (await new DurableCheckoutJournal(filePath).list())[0];
  expect(restored?.windowNotice).toBe(notice);
  expect(restored?.windowDeliveries).toEqual([{ channel: 'telegram', delivered: true, backfillable: false,
    receipt: { surfaceKind: 'telegram', conversationId: '-100123', messageId: '51', threadId: '7', accountId: '123' } }]);
  expect(restored?.phase).toBe('awaiting-window');
});

test.each([
  { surfaceKind: 'slack', conversationId: 'chat', messageId: '51' },
  { surfaceKind: 'telegram', conversationId: '', messageId: '51' },
  { surfaceKind: 'telegram', conversationId: 'chat', messageId: '51\nother' },
  { surfaceKind: 'telegram', conversationId: 'chat', messageId: '51', secret: 'not-a-receipt-field' },
])('invalid persisted notice receipt %j cannot be erased into missing correlation', async receipt => {
  const contents = JSON.stringify({ version: 1, records: [record({ phase: 'awaiting-window',
    windowDeliveries: [{ channel: 'telegram', delivered: true, backfillable: false, receipt } as unknown as NonNullable<InFlightCheckout['windowDeliveries']>[number]] })] });
  writeFileSync(filePath, contents);
  await expect(new DurableCheckoutJournal(filePath).list()).rejects.toBeInstanceOf(PaymentCheckoutJournalUnavailableError);
  expect(readFileSync(filePath, 'utf8')).toBe(contents);
});

describe('DurableCheckoutJournal: durable before put resolves', () => {
  test('a put record is on disk before the promise resolves, not merely in memory', async () => {
    const journal = new DurableCheckoutJournal(filePath);
    await journal.put(record());
    // Read the FILE, not the instance: this is the flush the submit-pending
    // guarantee rides on.
    expect(existsSync(filePath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(filePath, 'utf-8')) as { records: Record<string, unknown>[] };
    expect(onDisk.records).toHaveLength(1);
    expect(onDisk.records[0]!['purchaseId']).toBe('pur-journal-1');
    expect(onDisk.records[0]!['phase']).toBe('submit-pending');
  });

  test('a submit-pending record survives a restart byte-faithfully', async () => {
    const before = new DurableCheckoutJournal(filePath);
    await before.put(record());

    // A new instance over the same file IS the restart.
    const after = new DurableCheckoutJournal(filePath);
    const restored = await after.list();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toEqual(record());
  });

  test('remove drops the record from disk, so a finished checkout is not reported after a restart', async () => {
    const journal = new DurableCheckoutJournal(filePath);
    await journal.put(record());
    await journal.put(record({ purchaseId: 'pur-journal-2', pageId: 'page-2' }));
    await journal.remove('pur-journal-1');

    const after = new DurableCheckoutJournal(filePath);
    const restored = await after.list();
    expect(restored).toHaveLength(1);
    expect(restored[0]!.purchaseId).toBe('pur-journal-2');
  });

  test('a second put for the same purchaseId replaces the record, as a phase advance does', async () => {
    const journal = new DurableCheckoutJournal(filePath);
    await journal.put(record({ phase: 'arming-payment' }));
    await journal.put(record({ phase: 'submit-pending' }));
    const listed = await journal.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.phase).toBe('submit-pending');
  });
});

describe('DurableCheckoutJournal: unknown fields are opaque cargo', () => {
  test('fields this build has never seen round-trip untouched through a restart', async () => {
    // Future compatible metadata survives validation of the known record.
    const withUnknown = {
      ...record(),
      deliveries: [{ carrier: 'ups', trackingNumber: '1Z999', deliveredAt: null }],
      someFutureFlag: true,
    } as unknown as InFlightCheckout;
    const before = new DurableCheckoutJournal(filePath);
    await before.put(withUnknown);

    const after = new DurableCheckoutJournal(filePath);
    const restored = await after.list();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toEqual(withUnknown);
    const raw = restored[0] as unknown as Record<string, unknown>;
    expect(raw['deliveries']).toEqual([{ carrier: 'ups', trackingNumber: '1Z999', deliveredAt: null }]);
    expect(raw['someFutureFlag']).toBe(true);
  });
});

describe('DurableCheckoutJournal: damaged evidence is preserved and unavailable', () => {
  test.each([
    'not json at all {',
    JSON.stringify({ version: 1, records: 'not-an-array' }),
    JSON.stringify({ version: 2, records: [record()] }),
    JSON.stringify({ records: [record()] }),
    JSON.stringify({ version: 1, records: [record(), { phase: 'submit-pending', noId: true }] }),
    JSON.stringify({ version: 1, records: [record(), record()] }),
    JSON.stringify({ version: 1, records: [record({ phase: 'unknown' as InFlightCheckout['phase'] })] }),
    JSON.stringify({ version: 1, records: [record({ totalMinorUnits: -1 })] }),
    JSON.stringify({ version: 1, records: [record({ updatedAtMs: -1 })] }),
    JSON.stringify({ version: 1, records: [record({ windowDeliveries: [{ channel: 'telegram', delivered: true, backfillable: false }, { channel: 'telegram', delivered: true, backfillable: false }] })] }),
  ])('refuses a damaged or unsupported journal without overwriting it: %#', async contents => {
    writeFileSync(filePath, contents);
    // Construction remains available to the rest of the daemon.
    const journal = new DurableCheckoutJournal(filePath);
    await expect(journal.list()).rejects.toBeInstanceOf(PaymentCheckoutJournalUnavailableError);
    await expect(journal.put(record())).rejects.toBeInstanceOf(PaymentCheckoutJournalUnavailableError);
    await expect(journal.remove('pur-journal-1')).rejects.toBeInstanceOf(PaymentCheckoutJournalUnavailableError);
    expect(readFileSync(filePath, 'utf-8')).toBe(contents);
  });

  test('invalid UTF8 does not silently substitute characters in persisted identities', async () => {
    const bytes = Buffer.concat([Buffer.from('{"version":1,"records":['), Buffer.from([0xff]), Buffer.from(']}')]);
    writeFileSync(filePath, bytes);
    const journal = new DurableCheckoutJournal(filePath);
    await expect(journal.list()).rejects.toBeInstanceOf(PaymentCheckoutJournalUnavailableError);
    expect(readFileSync(filePath)).toEqual(bytes);
  });

  test.each(['symlink', 'hardlink'] as const)('does not adopt a %s as private checkout evidence', async kind => {
    const source = join(dir, 'original.json');
    writeFileSync(source, JSON.stringify({ version: 1, records: [record()] }));
    if (kind === 'symlink') symlinkSync(source, filePath); else linkSync(source, filePath);
    const original = readFileSync(source);
    const journal = new DurableCheckoutJournal(filePath);
    await expect(journal.put(record({ phase: 'submitted' }))).rejects.toBeInstanceOf(PaymentCheckoutJournalUnavailableError);
    expect(readFileSync(source)).toEqual(original);
  });

  test('a missing file is the ordinary first boot: empty, no file created until a put', async () => {
    const journal = new DurableCheckoutJournal(filePath);
    expect(await journal.list()).toHaveLength(0);
    expect(existsSync(filePath)).toBe(false);
  });
});

describe('DurableCheckoutJournal: publication and original file ownership', () => {
  test('borrowed values and listed nested evidence cannot mutate the next durable write', async () => {
    const journal = new DurableCheckoutJournal(filePath);
    const borrowed = { ...record(), windowDeliveries: [{ channel: 'telegram' as const, delivered: true, backfillable: true }],
      draw: { itemMinorUnits: 5000, overageMinorUnits: 578, toleranceMinorUnits: 0, totalMinorUnits: 5578 } };
    await journal.put(borrowed);
    borrowed.windowDeliveries[0]!.delivered = false; borrowed.draw.itemMinorUnits = 0;
    const listed = await journal.list();
    expect(() => Object.assign(listed[0]!.draw!, { itemMinorUnits: 1 })).toThrow();
    expect(() => Object.assign(listed[0]!.windowDeliveries![0]!, { delivered: false })).toThrow();
    await journal.put(record({ purchaseId: 'second', pageId: 'second' }));
    const restored = await new DurableCheckoutJournal(filePath).list();
    expect(restored.find(row => row.purchaseId === borrowed.purchaseId)).toMatchObject({
      draw: { itemMinorUnits: 5000 }, windowDeliveries: [{ delivered: true }],
    });
  });

  test.each(['put', 'remove'] as const)('a failed %s reports failure, preserves evidence and retires the uncertain writer', async operation => {
    // The original basename fits the filesystem; the atomic writer's longer
    // sibling name does not. Exercise real write failure without global mocks.
    const path = join(dir, 'j'.repeat(240));
    const original = JSON.stringify({ version: 1, records: [record()] });
    writeFileSync(path, original);
    const journal = new DurableCheckoutJournal(path);
    const mutation = operation === 'put' ? journal.put(record({ phase: 'submitted' })) : journal.remove('pur-journal-1');
    await expect(mutation).rejects.toBeInstanceOf(PaymentCheckoutJournalUnavailableError);
    await expect(journal.list()).rejects.toBeInstanceOf(PaymentCheckoutJournalUnavailableError);
    expect(readFileSync(path, 'utf-8')).toBe(original);
    expect(await new DurableCheckoutJournal(path).list()).toEqual([record()]);
  });

  test('a stale owner cannot overwrite a newer committed phase', async () => {
    const first = new DurableCheckoutJournal(filePath); await first.put(record({ phase: 'arming-payment' }));
    const stale = new DurableCheckoutJournal(filePath);
    await first.put(record());
    await expect(stale.remove('pur-journal-1')).rejects.toBeInstanceOf(PaymentCheckoutJournalUnavailableError);
    expect((await new DurableCheckoutJournal(filePath).list())[0]!.phase).toBe('submit-pending');
  });

  test('deleting a previously observed file does not turn it into first boot', async () => {
    const journal = new DurableCheckoutJournal(filePath); await journal.put(record());
    unlinkSync(filePath);
    await expect(journal.list()).rejects.toBeInstanceOf(PaymentCheckoutJournalUnavailableError);
    await expect(journal.put(record())).rejects.toBeInstanceOf(PaymentCheckoutJournalUnavailableError);
    expect(existsSync(filePath)).toBe(false);
  });

  test('failed durable removal keeps the actual registry page owner instead of admitting another checkout', async () => {
    const path = join(dir, 'r'.repeat(240));
    let journal = new DurableCheckoutJournal(filePath);
    const retained = record();
    const evidence = { put: (row: InFlightCheckout) => journal.put(row), remove: (id: string) => journal.remove(id), list: () => journal.list() };
    const registry = new CheckoutRegistry(evidence);
    await registry.open(retained);
    // Move the existing evidence to a valid basename for which the next atomic
    // sibling write fails. The storage port reopens that actual same record.
    renameSync(filePath, path); journal = new DurableCheckoutJournal(path);
    await expect(registry.close(retained.purchaseId)).rejects.toBeInstanceOf(PaymentCheckoutJournalUnavailableError);
    expect(registry.current(retained.sessionId, retained.pageId)?.purchaseId).toBe(retained.purchaseId);
    await expect(registry.open(record({ purchaseId: 'second' }))).rejects.toThrow('already in flight');
  });
});

describe('DurableCheckoutJournal: concurrent writes land through the atomic write', () => {
  test('many concurrent puts leave one parseable file holding every record', async () => {
    const journal = new DurableCheckoutJournal(filePath);
    await Promise.all(
      Array.from({ length: 20 }, (unused, index) =>
        journal.put(record({ purchaseId: `pur-concurrent-${String(index)}`, pageId: `page-${String(index)}` }))),
    );
    // The file parses (an interleaved non-atomic write would tear it) and a
    // restart sees all twenty.
    const restored = await new DurableCheckoutJournal(filePath).list();
    expect(restored).toHaveLength(20);
    const ids = restored.map((entry) => entry.purchaseId).sort();
    expect(new Set(ids).size).toBe(20);
  });

  test('interleaved puts and removes settle to exactly the surviving records', async () => {
    const journal = new DurableCheckoutJournal(filePath);
    await Promise.all([
      journal.put(record({ purchaseId: 'pur-a' })),
      journal.put(record({ purchaseId: 'pur-b' })),
      journal.put(record({ purchaseId: 'pur-c' })),
    ]);
    await Promise.all([journal.remove('pur-b'), journal.put(record({ purchaseId: 'pur-d' }))]);
    const restored = await new DurableCheckoutJournal(filePath).list();
    expect(restored.map((entry) => entry.purchaseId).sort()).toEqual(['pur-a', 'pur-c', 'pur-d']);
  });
});
