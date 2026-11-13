import { expect, test } from 'bun:test';
import { agentReviewStateLifecycle, freshReviewPatch, parseAgentReviewState, reviewedReviewPatch, staleReviewPatch } from '../../agent/review-state.ts';

test('review-state helpers produce the fields the four registries wrote by hand', () => {
  expect(freshReviewPatch()).toEqual({ reviewState: 'fresh', staleReason: undefined, reviewedAt: undefined });
  const reviewed = reviewedReviewPatch();
  expect(reviewed.reviewState).toBe('reviewed');
  expect(reviewed.staleReason).toBeUndefined();
  expect(Number.isNaN(Date.parse(reviewed.reviewedAt ?? ''))).toBe(false);
  expect(staleReviewPatch('  too old ')).toEqual({ reviewState: 'stale', staleReason: 'too old' });
  expect(staleReviewPatch('   ').staleReason).toBe('Marked stale by user.');
  expect(parseAgentReviewState('stale')).toBe('stale');
  expect(parseAgentReviewState('bogus')).toBe('fresh');
  expect(agentReviewStateLifecycle.can('stale', 'reviewed')).toBe(true);
});
