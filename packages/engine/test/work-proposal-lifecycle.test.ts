import { expect, test } from 'bun:test';
import { WorkProposalStore, workProposalLifecycle } from '../platform/src/platform/agents/work-proposal-store.js';

const input = { surfaceKind: 'ntfy', userId: 'owner', channelId: 'c', task: 'Fix login', summary: 'Fix login', ttlMs: 60_000 };

test('a proposal the owner was never shown cannot be answered', () => {
  const store = new WorkProposalStore();
  const proposal = store.create(input);
  expect(store.resolve(proposal.id, 'accepted')).toBeNull();
  expect(store.get(proposal.id)?.status).toBe('pending');
  expect(store.markDelivered(proposal.id)).not.toBeNull();
  expect(store.resolve(proposal.id, 'accepted')?.status).toBe('accepted');
  expect(store.resolve(proposal.id, 'declined')).toBeNull();
  store.dispose();
});

test('the table: pending is answered once; answered and expired are final', () => {
  expect(workProposalLifecycle.next('pending')).toEqual(['accepted', 'declined', 'expired']);
  for (const s of ['accepted', 'declined', 'expired'] as const) expect(workProposalLifecycle.isTerminal(s)).toBe(true);
  expect(workProposalLifecycle.isState('expired')).toBe(true);
});
