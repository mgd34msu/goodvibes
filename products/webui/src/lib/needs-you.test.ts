/**
 * The sidebar's Work number is the Work page's "Needs you" count: an approval
 * with no fleet node counts, a ready best-of-N group counts once not once per
 * attempt, and an approval-blocked node whose approval is listed is not counted twice.
 */
import { describe, expect, test } from 'bun:test';
import type { ApprovalRecord, FleetAttemptGroup, FleetProcessNode } from './goodvibes';
import { buildWorkItems, groupWorkItems } from '../views/work/work-items';
import { needsYouCount } from './needs-you';

function node(partial: Partial<FleetProcessNode> & { id: string }): FleetProcessNode {
  return {
    kind: 'agent', label: partial.id, state: 'thinking', elapsedMs: 1000, startedAt: 1_700_000_000_000,
    costUsd: null, costState: 'unpriced',
    capabilities: { interruptible: false, killable: false, pausable: false, resumable: false, steerable: false },
    ...partial,
  } as FleetProcessNode;
}

function approval(partial: Partial<ApprovalRecord> & { id: string }): ApprovalRecord {
  return {
    callId: 'c', status: 'pending', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, metadata: {},
    request: { callId: 'c', tool: 'bash', args: {}, category: 'execute', analysis: { riskLevel: 'medium', summary: 'run', reasons: [] } },
    ...partial,
  } as ApprovalRecord;
}

const pick = (id: string) => node({ id, attemptGroup: { groupId: 'g1' }, needsAttention: { reason: 'pick' } } as Partial<FleetProcessNode> & { id: string });

describe('needsYouCount', () => {
  test('a pending approval with no fleet node counts', () => {
    const sources = { approvals: [approval({ id: 'a1' })], nodes: [], attemptGroups: [] };
    expect(needsYouCount(sources)).toBe(1);
  });

  test('a ready best-of-N group counts once, not once per flagged attempt node', () => {
    const group = { groupId: 'g1', sourceTitle: 'Build', ready: true, candidates: [{ state: 'held-merge' }, { state: 'held-merge' }], judgment: null } as unknown as FleetAttemptGroup;
    expect(needsYouCount({ approvals: [], nodes: [pick('p1'), pick('p2')], attemptGroups: [group] })).toBe(1);
  });

  test('an approval-blocked node whose approval is listed is not counted a second time', () => {
    const sources = {
      approvals: [approval({ id: 'a1', sessionId: 's1' })],
      nodes: [node({ id: 'n1', sessionRef: { sessionId: 's1', agentId: 'n1' }, needsAttention: { reason: 'approval' } } as Partial<FleetProcessNode> & { id: string })],
      attemptGroups: [],
    };
    expect(needsYouCount(sources)).toBe(1);
  });

  test('equals the page count for the same sources', () => {
    const sources = {
      approvals: [approval({ id: 'a1' })],
      nodes: [node({ id: 'blocked', needsAttention: { reason: 'input' } } as Partial<FleetProcessNode> & { id: string }), node({ id: 'live' })],
      attemptGroups: [],
    };
    const page = groupWorkItems(buildWorkItems({ ...sources, sessions: [], hosted: [], tasks: [], ciWatches: [] }), 'all').needs.length;
    expect(needsYouCount(sources)).toBe(page);
    expect(page).toBe(2);
  });
});
