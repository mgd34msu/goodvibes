import { describe, expect, test } from 'bun:test';
import {
  handleBrokerApprovalChange,
  settledAskDecision,
  type BrokerApprovalCardBroker,
  type SettledApprovalRecord,
} from '../../permissions/broker-approval-card.ts';
import type { PendingPermissionState } from '../../shell/blocking-input.ts';

const record = (overrides: Partial<SettledApprovalRecord>): SettledApprovalRecord => ({
  callId: 'c1', status: 'approved', updatedAt: 100, resolvedAt: 100, ...overrides,
});

describe('settledAskDecision', () => {
  test('carries the amended arguments and remember tier of a remote approval', () => {
    const modifiedArgs = { edits: [{ id: 1 }, { id: 3 }] };
    const decision = settledAskDecision([record({ decision: { approved: true, rememberTier: 'session', modifiedArgs } })], 'c1', 50);
    expect(decision).toEqual({ approved: true, remember: false, rememberTier: 'session', modifiedArgs });
  });
  test('a denial stays a denial and drops amended arguments', () => {
    const decision = settledAskDecision([record({ status: 'denied', decision: { approved: false, reason: 'no', modifiedArgs: { a: 1 } } })], 'c1', 50);
    expect(decision).toEqual({ approved: false, remember: false, reason: 'no' });
  });
  test('a record settled before the ask was queued does not answer it', () => {
    expect(settledAskDecision([record({ resolvedAt: 10, updatedAt: 10 })], 'c1', 50)).toBeNull();
  });
  test('a still-waiting record does not answer', () => {
    expect(settledAskDecision([record({ status: 'pending' }), record({ status: 'claimed' })], 'c1', 0)).toBeNull();
  });
  test('the newest settled record for the call wins', () => {
    const decision = settledAskDecision([
      record({ resolvedAt: 200, updatedAt: 200, status: 'denied', decision: { approved: false } }),
      record({ resolvedAt: 100, updatedAt: 100 , decision: { approved: true } }),
    ], 'c1', 50);
    expect(decision?.approved).toBe(false);
  });
});

describe('a failed answer to the broker', () => {
  test('tells the owner and offers the card again while the ask still waits', async () => {
    const request = { callId: 'c1', tool: 'ci-fix', reason: 'r', args: {} } as never;
    let pending: PendingPermissionState | null = null;
    let attempts = 0;
    const notices: string[] = [];
    const broker = {
      listApprovals: () => [],
      getApproval: () => ({ status: 'pending', request }),
      resolveApproval: async () => { attempts += 1; throw new Error('claimed elsewhere'); },
    } as unknown as BrokerApprovalCardBroker;
    handleBrokerApprovalChange({
      approval: { id: 'a1', callId: 'c1', status: 'pending', request },
      getPending: () => pending,
      setPending: (next) => { pending = next; },
      broker,
      render: () => {},
      defer: (cb) => cb(),
      notify: (message) => notices.push(message),
    });
    const first = pending as PendingPermissionState | null;
    first!.resolve(true, false);
    pending = null; // the caller clears the card on answer
    await Promise.resolve(); await Promise.resolve();
    expect(attempts).toBe(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('claimed elsewhere');
    expect(pending).not.toBeNull();
  });
});
