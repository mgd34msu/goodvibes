import { describe, expect, test } from 'bun:test';
import { buildAwayDigest, type AwayDigestInput } from '../../core/away-digest.ts';

const everything: AwayDigestInput = {
  lastSeenAt: 1_000,
  pendingApprovals: 2,
  tasks: [
    { title: 'Index the notes', status: 'done' },
    { title: 'Sync the calendar', status: 'failed' },
  ],
  failedRuns: [{ name: 'Nightly backup' }],
  missedRuns: [{ name: 'Morning briefing' }],
  schedules: [{ name: 'Stretch', runCount: 1, lastRunAt: 2_000 }],
  deliveries: [{ label: 'Weekly summary' }],
};

describe('away digest overflow', () => {
  test('lines beyond the cap are counted, not silently dropped', () => {
    const digest = buildAwayDigest(everything)!;
    expect(digest.lines).toHaveLength(5);
    expect(digest.lines.at(-1)).toBe('and 3 more in Activity');
  });

  test('the unreadable-approvals qualifier stays inside the cap alongside the overflow line', () => {
    const digest = buildAwayDigest({ ...everything, approvalsUnavailableReason: 'host unreachable' })!;
    expect(digest.lines).toHaveLength(5);
    expect(digest.lines.at(-2)).toBe('and 4 more in Activity');
    expect(digest.lines.at(-1)).toContain('host unreachable');
  });

  test('a finished task is not called research', () => {
    const digest = buildAwayDigest({ lastSeenAt: 1_000, pendingApprovals: 0, schedules: [], tasks: [{ title: 'Book flights', status: 'done' }] })!;
    expect(digest.lines[0]).toBe('A task finished: Book flights');
  });
});
