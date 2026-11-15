import { describe, expect, test } from 'bun:test';
import { formatConsolidationProposalForReview } from '../../agent/memory-consolidation-proposals.ts';

describe('formatConsolidationProposalForReview', () => {
  test('names the kind, the reason, the referenced ids, and a jump-in review command', () => {
    const line = formatConsolidationProposalForReview({
      kind: 'contradiction',
      ids: ['mem-1', 'mem-2'],
      route: '/memory/review',
      reason: 'these two disagree about deploy cadence',
    });
    expect(line).toContain('contradiction');
    expect(line).toContain('mem-1');
    expect(line).toContain('mem-2');
    expect(line).toContain('these two disagree about deploy cadence');
    expect(line).toContain('/memory review mem-1');
  });

  test('cross-scope-duplicate and stale-delete get legible (not raw-enum) labels', () => {
    const dup = formatConsolidationProposalForReview({
      kind: 'cross-scope-duplicate',
      ids: ['mem-9'],
      route: '/memory/review',
      reason: 'duplicate across scopes',
    });
    expect(dup).toContain('cross-scope duplicate');
    expect(dup).not.toContain('cross-scope-duplicate');

    const stale = formatConsolidationProposalForReview({
      kind: 'stale-delete',
      ids: ['mem-10'],
      route: '/memory/review',
      reason: 'never referenced since creation',
    });
    expect(stale).toContain('stale, never referenced');
  });
});
