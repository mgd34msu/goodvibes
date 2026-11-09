/**
 * DaemonApprovalStore: the properties under test are the four the SDK's
 * owner-approval ruling names, kept across a restart. Single use must hold on
 * disk (an approval spent before a restart must not be spendable after one),
 * the content binding keeps its existing wire format, the TTL must expire
 * records, and corrupt evidence must remain preserved and unavailable.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'bun:test';
import { DaemonApprovalStore, PaymentApprovalStoreError } from '../sdk/src/platform/payments/host/approval-store.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const ACTION = 'payments.checkout.begin';
const CONTENT = { merchant: 'example.invalid', item: 'a test item', amount: '20.00' } as const;

let filePath = '';

beforeEach(() => {
  filePath = join(makeProjectTempDir('gv-approval-store'), 'payments-approvals.json');
});

describe('DaemonApprovalStore: persisted, single use, content bound', () => {
  test('a grant survives a restart and is spendable exactly once across it', () => {
    const before = new DaemonApprovalStore(filePath);
    before.grant({ action: ACTION, content: CONTENT });

    // Restart one: the approval is there and spends.
    const after = new DaemonApprovalStore(filePath);
    const taken = after.take({ action: ACTION, content: CONTENT });
    expect(taken.approval).not.toBeNull();

    // Restart two: the SPEND was persisted, so nothing is left to spend.
    const again = new DaemonApprovalStore(filePath);
    const missed = again.take({ action: ACTION, content: CONTENT });
    expect(missed.approval).toBeNull();
    if (missed.approval === null) expect(missed.mismatch).toBe('none');
  });

  test('take refuses different content and leaves the record unspent', () => {
    const store = new DaemonApprovalStore(filePath);
    store.grant({ action: ACTION, content: CONTENT });

    const wrongAmount = store.take({ action: ACTION, content: { ...CONTENT, amount: '999.99' } });
    expect(wrongAmount.approval).toBeNull();
    if (wrongAmount.approval === null) expect(wrongAmount.mismatch).toBe('different-content');

    // Still spendable by the matching payload: the mismatch took nothing.
    expect(store.take({ action: ACTION, content: CONTENT }).approval).not.toBeNull();
  });

  test('an expired approval is not spendable, in memory or across a restart', () => {
    let nowMs = Date.parse('2026-08-21T12:00:00.000Z');
    const clock = (): Date => new Date(nowMs);
    const store = new DaemonApprovalStore(filePath, clock);
    store.grant({ action: ACTION, content: CONTENT });

    nowMs += 6 * 60 * 1000; // past the SDK's five-minute TTL
    const missed = store.take({ action: ACTION, content: CONTENT });
    expect(missed.approval).toBeNull();
    if (missed.approval === null) expect(missed.mismatch).toBe('expired');

    // A reload at the later clock sweeps it at construction.
    const reloaded = new DaemonApprovalStore(filePath, clock);
    expect(reloaded.pendingCount()).toBe(0);
  });

  test('the store is bounded: overflowing evicts the oldest grant, not the newest', () => {
    const store = new DaemonApprovalStore(filePath);
    for (let index = 0; index < 20; index += 1) {
      store.grant({ action: ACTION, content: { ...CONTENT, item: `item-${String(index)}` } });
    }
    expect(store.pendingCount()).toBeLessThanOrEqual(16);
    // The newest is spendable; the oldest was the one evicted.
    expect(store.take({ action: ACTION, content: { ...CONTENT, item: 'item-19' } }).approval).not.toBeNull();
    const oldest = store.take({ action: ACTION, content: { ...CONTENT, item: 'item-0' } });
    expect(oldest.approval).toBeNull();
  });
});

describe('DaemonApprovalStore: damaged evidence remains unavailable', () => {
  test('a finite but reversed saved window preserves its original evidence and refuses all access', () => {
    const now = () => new Date('2026-01-01T00:00:00.000Z');
    new DaemonApprovalStore(filePath, now).grant({ action: ACTION, content: CONTENT });
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { approvals: { grantedAt: string; expiresAt: string }[] };
    const row = raw.approvals[0];
    if (!row) throw new Error('Missing saved approval');
    row.expiresAt = row.grantedAt;
    writeFileSync(filePath, JSON.stringify(raw));
    const bytes = readFileSync(filePath);
    const reopened = new DaemonApprovalStore(filePath, now);
    expect(() => reopened.take({ action: ACTION, content: CONTENT })).toThrow(PaymentApprovalStoreError);
    expect(() => reopened.grant({ action: ACTION, content: CONTENT })).toThrow(PaymentApprovalStoreError);
    expect(readFileSync(filePath)).toEqual(bytes);
  });

  test('a file that is not JSON is preserved and cannot be overwritten by a new grant', () => {
    writeFileSync(filePath, '{{{ not json', 'utf-8');
    const store = new DaemonApprovalStore(filePath);
    expect(() => store.pendingCount()).toThrow(PaymentApprovalStoreError);
    expect(() => store.grant({ action: ACTION, content: CONTENT })).toThrow(PaymentApprovalStoreError);
    expect(readFileSync(filePath, 'utf8')).toBe('{{{ not json');
  });

  test('one malformed row preserves the whole file for repair without silently dropping evidence', () => {
    const good = new DaemonApprovalStore(filePath);
    good.grant({ action: ACTION, content: CONTENT });
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as { version: number; approvals: unknown[] };
    raw.approvals.push({ action: ACTION, surface: 'web-page', grantedAt: 'x', expiresAt: 'y', contentFingerprint: null });
    writeFileSync(filePath, JSON.stringify(raw), 'utf-8');

    const before = readFileSync(filePath);
    const reloaded = new DaemonApprovalStore(filePath);
    expect(() => reloaded.pendingCount()).toThrow(PaymentApprovalStoreError);
    expect(() => reloaded.take({ action: ACTION, content: CONTENT })).toThrow(PaymentApprovalStoreError);
    expect(readFileSync(filePath)).toEqual(before);
  });
});
