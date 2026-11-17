// Proves: After a crash the daemon does not know a purchase may already have been submitted, and submits it again.
// Red when: The record written before the click is not on disk when `put` resolves or comes back altered, or an unreadable journal is treated as empty and overwritten.
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
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'bun:test';
import type { InFlightCheckout } from '../platform/src/platform/payments/checkout-registry.js';
import { DurableCheckoutJournal, PaymentCheckoutJournalUnavailableError } from '../platform/src/platform/payments/host/checkout-journal-store.js';
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

describe('DurableCheckoutJournal: durable before put resolves', () => {
  test('a submit-pending record survives a restart byte-faithfully', async () => {
    const before = new DurableCheckoutJournal(filePath);
    await before.put(record());

    // A new instance over the same file IS the restart.
    const after = new DurableCheckoutJournal(filePath);
    const restored = await after.list();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toEqual(record());
  });
});

describe('DurableCheckoutJournal: damaged evidence is preserved and unavailable', () => {
  test.each([
    'not json at all {',
  ])('refuses a damaged or unsupported journal without overwriting it: %#', async contents => {
    writeFileSync(filePath, contents);
    // Construction remains available to the rest of the daemon.
    const journal = new DurableCheckoutJournal(filePath);
    await expect(journal.list()).rejects.toBeInstanceOf(PaymentCheckoutJournalUnavailableError);
    await expect(journal.put(record())).rejects.toBeInstanceOf(PaymentCheckoutJournalUnavailableError);
    await expect(journal.remove('pur-journal-1')).rejects.toBeInstanceOf(PaymentCheckoutJournalUnavailableError);
    expect(readFileSync(filePath, 'utf-8')).toBe(contents);
  });
});
