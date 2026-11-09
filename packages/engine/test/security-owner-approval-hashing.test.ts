/** Commitments are computed only for real comparisons, never as live authority. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { OwnerApprovalStore, checkOwnerApproval, fingerprintOutwardContent, grantOwnerApproval } from '../platform/src/platform/security/owner-approval.js';
import { DaemonApprovalStore } from '../platform/src/platform/payments/host/approval-store.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const action = 'send-fixture';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('empty, wrong-action, expired and unbound pending stores do not fingerprint ordinary outgoing content', () => {
  const empty = new OwnerApprovalStore(), wrong = new OwnerApprovalStore(), unbound = new OwnerApprovalStore();
  wrong.grant({ action: 'different-action', surface: 'owner-direct', content: { body: 'Original' } });
  unbound.grant({ action, surface: 'owner-direct' });
  let now = Date.parse('2026-11-01T00:00:00Z');
  const expired = new OwnerApprovalStore(() => new Date(now));
  expired.grant({ action, surface: 'owner-direct', content: { body: 'Original' }, ttlMs: 1 }); now += 2;
  const hashes = spyOn(crypto, 'createHash');
  try {
    expect(empty.take({ action, content: { body: 'Current' } })).toBeNull();
    expect(wrong.take({ action, content: { body: 'Current' } })).toBeNull();
    expect(expired.take({ action, content: { body: 'Current' } })).toBeNull();
    expect(unbound.take({ action, content: { body: 'Current' } })?.contentFingerprint).toBeNull();
    expect(hashes).not.toHaveBeenCalled();
  } finally { hashes.mockRestore(); }
});

test('several same-action in-memory candidates compare the actual outgoing content once', () => {
  const store = new OwnerApprovalStore();
  for (let index = 0; index < 8; index++) store.grant({ action, surface: 'owner-direct', content: { body: `Wrong ${index}` } });
  const original = store.grant({ action, surface: 'owner-direct', content: { body: 'Exact original' } });
  const hashes = spyOn(crypto, 'createHash');
  try {
    expect(store.take({ action, content: { body: 'Exact original' } })).toBe(original);
    expect(hashes).toHaveBeenCalledTimes(1);
  } finally { hashes.mockRestore(); }
});

test('actual persisted approval take hashes its captured immutable content once across sixteen real candidates', () => {
  const root = makeProjectTempDir('approval-fingerprint-reuse'); roots.push(root);
  const store = new DaemonApprovalStore(join(root, 'approvals.json'));
  for (let index = 0; index < 15; index++) store.grant({ action, content: { body: `Wrong persisted ${index}` } });
  const granted = store.grant({ action, content: { body: 'Exact persisted original' } });
  expect(store.pendingCount()).toBe(16);
  const hashes = spyOn(crypto, 'createHash');
  try {
    const taken = store.take({ action, content: { body: 'Exact persisted original' } });
    expect(taken.approval).toEqual(granted);
    expect(hashes).toHaveBeenCalledTimes(1);
    expect(store.pendingCount()).toBe(15);
  } finally { hashes.mockRestore(); }
});

test('only the actual immutable ordinary field record reuses a digest; action and expiry checks stay live', () => {
  const at = Date.parse('2026-11-01T00:00:00Z'), fields = Object.freeze({ body: 'Exact original' });
  const approval = grantOwnerApproval({ action, surface: 'owner-direct', content: { body: fields.body }, ttlMs: 1000, now: () => new Date(at) });
  const hashes = spyOn(crypto, 'createHash');
  try {
    const expected = fingerprintOutwardContent(fields);
    expect(fingerprintOutwardContent(fields)).toBe(expected);
    expect(hashes).toHaveBeenCalledTimes(1);
    expect(checkOwnerApproval({ approval, action, contentInQuestion: fields, clearingContentTaint: true, now: () => new Date(at + 1) }).authorized).toBe(true);
    expect(checkOwnerApproval({ approval, action: 'different', contentInQuestion: fields, clearingContentTaint: true, now: () => new Date(at + 1) }).authorized).toBe(false);
    expect(checkOwnerApproval({ approval, action, contentInQuestion: fields, clearingContentTaint: true, now: () => new Date(at + 1001) })).toMatchObject({ authorized: false, mismatch: 'expired' });
    expect(hashes).toHaveBeenCalledTimes(1);
    expect(fingerprintOutwardContent(Object.freeze({ ...fields }))).toBe(expected);
    expect(hashes).toHaveBeenCalledTimes(2); // Copied data does not inherit another object's memo.
  } finally { hashes.mockRestore(); }
});

test('mutable records, frozen accessors and proxies never acquire immutable fingerprint reuse', () => {
  const hashes = spyOn(crypto, 'createHash');
  try {
    const mutable = { body: 'First' };
    const first = fingerprintOutwardContent(mutable);
    expect(fingerprintOutwardContent(mutable)).toBe(first);
    mutable.body = 'Changed'; expect(fingerprintOutwardContent(mutable)).not.toBe(first);
    expect(hashes).toHaveBeenCalledTimes(3);
    let getterCalls = 0;
    const accessor = Object.freeze(Object.defineProperty({}, 'body', { enumerable: true, get() { return `Getter ${++getterCalls}`; } }));
    const getterFirst = fingerprintOutwardContent(accessor);
    expect(fingerprintOutwardContent(accessor)).not.toBe(getterFirst);
    expect(getterCalls).toBe(2); expect(hashes).toHaveBeenCalledTimes(5);
    let traps = 0;
    const proxy = new Proxy(Object.freeze({ body: 'Proxy input' }), { ownKeys(target) { traps++; return Reflect.ownKeys(target); } });
    expect(fingerprintOutwardContent(proxy)).toBe(fingerprintOutwardContent(proxy));
    expect(traps).toBe(2); expect(hashes).toHaveBeenCalledTimes(7);
    let hiddenCalls = 0;
    const hidden = Object.freeze(Object.defineProperty({ body: 'Visible only' }, 'hidden', { get() { hiddenCalls++; return 'Hidden'; } }));
    expect(fingerprintOutwardContent(hidden)).toBe(fingerprintOutwardContent(hidden));
    expect(hiddenCalls).toBe(0); expect(hashes).toHaveBeenCalledTimes(9);
  } finally { hashes.mockRestore(); }
});
