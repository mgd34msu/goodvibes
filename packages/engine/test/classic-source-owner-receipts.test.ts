import { expect, test } from 'bun:test';
import { createClassicProtectedSourceOwner } from '../platform/src/platform/security/source-screening/classic-owner.js';

function owner() {
  const controller = new AbortController();
  return createClassicProtectedSourceOwner({ ownerId: 'owner-1', revision: 'rev-1', signal: controller.signal, assertCurrent: () => {} });
}

test('screening one handle again returns the receipt it already issued', async () => {
  const classic = owner();
  const handle = classic.capture(['hello world']);
  const first = await classic.screen(handle);
  const second = await classic.screen(handle);
  expect(first.status).toBe('settled');
  expect(second.status).toBe('settled');
  if (first.status === 'settled' && second.status === 'settled') {
    expect(second.receipt).toBe(first.receipt);
    expect(classic.project(second.receipt)).toEqual(['hello world']);
  }
});

test('a released handle is held, not served from an earlier receipt', async () => {
  const classic = owner();
  const handle = classic.capture(['hello world']);
  await classic.screen(handle);
  await classic.release(handle);
  expect(await classic.screen(handle)).toEqual({ status: 'held', reason: 'stale' });
});

test('different handles get their own receipts', async () => {
  const classic = owner();
  const a = await classic.screen(classic.capture(['a']));
  const b = await classic.screen(classic.capture(['b']));
  expect(a.status === 'settled' && b.status === 'settled' && a.receipt !== b.receipt).toBe(true);
});
