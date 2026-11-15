/**
 * Continuation grants and cancelled-source tombstones are kept while their
 * pairing exists (a consumed or revoked grant must keep refusing its source) and
 * dropped with the pairing, which is the only point at which they cannot be presented.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PairingTokenManager, type NativeContinuationAuthority } from '../platform/src/platform/pairing/pairing-token-store.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const pin = (value: number) => value.toString(16).padStart(64, '0');
const current = () => {};
const scopes = ['read:work-ledger'];
function open() {
  const root = mkdtempSync(join(tmpdir(), 'pairing-prune-')); roots.push(root);
  const file = join(root, 'pairing.json');
  const manager = new PairingTokenManager(file);
  const pair = (name: string) => {
    const token = manager.mint({ name });
    const authority: NativeContinuationAuthority = { ...manager.authenticateNative(token.token)!, scopes };
    return { token, authority };
  };
  const stored = () => JSON.parse(readFileSync(file, 'utf8')) as { continuations?: { tokenId: string; sourceBinding: string }[]; revokedNativeSources?: string[] };
  return { manager, pair, stored };
}

test('revoking a pairing drops its grants and the cancelled sources only they referenced, and nothing else', () => {
  const { manager, pair, stored } = open();
  const gone = pair('Pairing that will be revoked'), kept = pair('Pairing that stays');
  manager.issueNativeContinuation(gone.token.token, gone.authority, pin(1), current, pin(10));
  manager.issueNativeContinuation(kept.token.token, kept.authority, pin(2), current, pin(20));
  manager.revokeNativeContinuationsForSource(pin(10), current);
  manager.revokeNativeContinuationsForSource(pin(20), current);
  // A cancellation recorded before any grant existed has no pairing to prove it dead.
  manager.revokeNativeContinuationsForSource(pin(30), current);
  expect(stored().continuations).toHaveLength(2);
  expect(stored().revokedNativeSources).toEqual([pin(10), pin(20), pin(30)]);

  expect(manager.revoke(gone.token.id)).toBe(true);

  expect(stored().continuations?.map(grant => grant.tokenId)).toEqual([kept.token.id]);
  expect(stored().revokedNativeSources).toEqual([pin(20), pin(30)]);
});

test('a revoked grant of a pairing that still exists stays, so its source cannot be issued again', () => {
  const { manager, pair, stored } = open();
  const live = pair('Live pairing');
  manager.issueNativeContinuation(live.token.token, live.authority, pin(1), current, pin(10));
  manager.revokeNativeContinuationsForSource(pin(10), current);
  manager.mint({ name: 'Another write' });
  expect(stored().continuations).toHaveLength(1);
  expect(() => manager.issueNativeContinuation(live.token.token, live.authority, pin(3), current, pin(10))).toThrow();
});
