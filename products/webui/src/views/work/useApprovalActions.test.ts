import { describe, expect, test } from 'bun:test';
import type { ApprovalActionResult, ApprovalRecord } from '../../lib/goodvibes';
import { describeUnappliedDecision } from './useApprovalActions';

function record(status: ApprovalRecord['status']): ApprovalRecord {
  return {
    id: 'appr-1',
    callId: 'call-1',
    status,
    request: {
      callId: 'call-1',
      tool: 'exec',
      args: {},
      category: 'execute',
      analysis: { classification: 'exec', riskLevel: 'medium', summary: 'run a command', reasons: [] },
    },
    createdAt: 100,
    updatedAt: 100,
    metadata: {},
    audit: [],
  };
}

describe('a decision on an approval that already ended', () => {
  test('approving an expired ask says nothing changed instead of "Approved"', () => {
    const result = { approval: record('expired'), applied: false, refusal: 'Approval is expired by approval-broker, which is final; it cannot become approved. Nothing changed.' };
    expect(describeUnappliedDecision(result, 'approve')).toEqual({
      title: 'Already expired, nothing changed',
      description: result.refusal,
      tone: 'info',
    });
  });

  test('a daemon without the applied flag is read from the returned status', () => {
    const result: ApprovalActionResult = { approval: record('approved') };
    expect(describeUnappliedDecision(result, 'deny')?.title).toBe('Already approved, nothing changed');
    expect(describeUnappliedDecision(result, 'approve')).toBeNull();
  });

  test('an applied decision gets its normal toast', () => {
    expect(describeUnappliedDecision({ approval: record('cancelled'), applied: true }, 'cancel')).toBeNull();
  });
});
