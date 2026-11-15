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

test('empty, wrong-action, expired and unbound pending stores take nothing for ordinary outgoing content, and an unbound grant carries no fingerprint', () => {
  const empty = new OwnerApprovalStore(), wrong = new OwnerApprovalStore(), unbound = new OwnerApprovalStore();
  wrong.grant({ action: 'different-action', surface: 'owner-direct', content: { body: 'Original' } });
  unbound.grant({ action, surface: 'owner-direct' });
  let now = Date.parse('2026-11-01T00:00:00Z');
  const expired = new OwnerApprovalStore(() => new Date(now));
  expired.grant({ action, surface: 'owner-direct', content: { body: 'Original' }, ttlMs: 1 }); now += 2;
  expect(empty.take({ action, content: { body: 'Current' } })).toBeNull();
  expect(wrong.take({ action, content: { body: 'Current' } })).toBeNull();
  expect(expired.take({ action, content: { body: 'Current' } })).toBeNull();
  expect(unbound.take({ action, content: { body: 'Current' } })?.contentFingerprint).toBeNull();
});

test('several same-action in-memory candidates compare the actual outgoing content once', () => {
  const store = new OwnerApprovalStore();
  for (let index = 0; index < 8; index++) store.grant({ action, surface: 'owner-direct', content: { body: `Wrong ${index}` } });
  const original = store.grant({ action, surface: 'owner-direct', content: { body: 'Exact original' } });
  const hashes = spyOn(crypto, 'createHash');
  try {
    expect(store.take({ action, content: { body: 'Exact original' } })).toBe(original);
    // The memo contract: the outgoing content is fingerprinted once, not once per pending candidate.
    expect(hashes).toHaveBeenCalledTimes(1);
  } finally { hashes.mockRestore(); }
});

test('a persisted take spends only the candidate bound to the exact content, among sixteen real candidates', () => {
  const root = makeProjectTempDir('approval-fingerprint-reuse'); roots.push(root);
  const store = new DaemonApprovalStore(join(root, 'approvals.json'));
  for (let index = 0; index < 15; index++) store.grant({ action, content: { body: `Wrong persisted ${index}` } });
  const granted = store.grant({ action, content: { body: 'Exact persisted original' } });
  expect(store.pendingCount()).toBe(16);
  expect(store.take({ action, content: { body: 'Never granted' } }).approval).toBeNull();
  expect(store.pendingCount()).toBe(16);
  const taken = store.take({ action, content: { body: 'Exact persisted original' } });
  expect(taken.approval).toEqual(granted);
  expect(store.pendingCount()).toBe(15);
});

test('an immutable field record fingerprints the same as a copy, while action and expiry checks stay live', () => {
  const at = Date.parse('2026-11-01T00:00:00Z'), fields = Object.freeze({ body: 'Exact original' });
  const approval = grantOwnerApproval({ action, surface: 'owner-direct', content: { body: fields.body }, ttlMs: 1000, now: () => new Date(at) });
  const expected = fingerprintOutwardContent(fields);
  expect(fingerprintOutwardContent(fields)).toBe(expected);
  expect(checkOwnerApproval({ approval, action, contentInQuestion: fields, clearingContentTaint: true, now: () => new Date(at + 1) }).authorized).toBe(true);
  expect(checkOwnerApproval({ approval, action: 'different', contentInQuestion: fields, clearingContentTaint: true, now: () => new Date(at + 1) }).authorized).toBe(false);
  expect(checkOwnerApproval({ approval, action, contentInQuestion: fields, clearingContentTaint: true, now: () => new Date(at + 1001) })).toMatchObject({ authorized: false, mismatch: 'expired' });
  expect(checkOwnerApproval({ approval, action, contentInQuestion: { body: 'Changed' }, clearingContentTaint: true, now: () => new Date(at + 1) }).authorized).toBe(false);
  expect(fingerprintOutwardContent(Object.freeze({ ...fields }))).toBe(expected);
});

test('mutable records, frozen accessors and proxies are fingerprinted from their current content every time', () => {
  const mutable = { body: 'First' };
  const first = fingerprintOutwardContent(mutable);
  expect(fingerprintOutwardContent(mutable)).toBe(first);
  mutable.body = 'Changed'; expect(fingerprintOutwardContent(mutable)).not.toBe(first);
  let getterCalls = 0;
  const accessor = Object.freeze(Object.defineProperty({}, 'body', { enumerable: true, get() { return `Getter ${++getterCalls}`; } }));
  const getterFirst = fingerprintOutwardContent(accessor);
  expect(fingerprintOutwardContent(accessor)).not.toBe(getterFirst);
  expect(getterCalls).toBe(2);
  let traps = 0;
  const proxy = new Proxy(Object.freeze({ body: 'Proxy input' }), { ownKeys(target) { traps++; return Reflect.ownKeys(target); } });
  expect(fingerprintOutwardContent(proxy)).toBe(fingerprintOutwardContent(proxy));
  expect(traps).toBe(2);
  let hiddenCalls = 0;
  const hidden = Object.freeze(Object.defineProperty({ body: 'Visible only' }, 'hidden', { get() { hiddenCalls++; return 'Hidden'; } }));
  expect(fingerprintOutwardContent(hidden)).toBe(fingerprintOutwardContent(hidden));
  expect(hiddenCalls).toBe(0);
});
