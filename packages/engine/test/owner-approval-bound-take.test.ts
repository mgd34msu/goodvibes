import { expect, test } from 'bun:test';
import { OwnerApprovalStore } from '../platform/src/platform/security/owner-approval.js';

const action = 'send-fixture';

test('an approval bound to a payload is not spent by a caller that names no content', () => {
  const store = new OwnerApprovalStore();
  store.grant({ action, surface: 'owner-direct', content: { body: 'Approved message' } });
  expect(store.take({ action })).toBeNull();
  expect(store.take({ action, content: {} })).toBeNull();
  expect(store.take({ action, content: { body: undefined } })).toBeNull();
  // Refusing did not spend it: the payload it was given for still takes it.
  expect(store.pendingCount()).toBe(1);
  expect(store.take({ action, content: { body: 'Approved message' } })).not.toBeNull();
});

test('an approval that was never bound still matches an action with no content', () => {
  const store = new OwnerApprovalStore();
  store.grant({ action, surface: 'owner-direct' });
  expect(store.take({ action })).not.toBeNull();
});
