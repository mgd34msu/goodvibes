/**
 * The permission manager's per-call bookkeeping is bounded: a settled call drops
 * its pending owner edit, and a settled call's replay claim is forgotten only
 * after a bounded number of later calls have settled.
 */
import { describe, expect, test } from 'bun:test';
import { PermissionManager, type PermissionConfigReader } from '../platform/src/platform/permissions/manager.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';

interface Internals {
  recordOwnerRevision(sourceId: string, revision: { toolName: string; args: Record<string, unknown>; authority: unknown }): void;
  ownerRevisions: Map<string, unknown>;
  autonomousClaims: Set<string>;
}
function manager(limits: { ownerRevisions?: number; retiredClaims?: number }) {
  const config = { getAutonomousSnapshot: () => ({}), isAutoApproveEnabled: () => false, getWorkingDirectory: () => '/synthetic', getSnapshot: () => ({}) } as unknown as PermissionConfigReader;
  const permissions = new PermissionManager(undefined, config, new PolicyRuntimeState(), null, null, null, { bookkeepingLimits: limits });
  return { permissions, internals: permissions as unknown as Internals };
}
const revision = { toolName: 'exec', args: {}, authority: undefined };

describe('permission manager bookkeeping', () => {
  test('past capacity the oldest pending owner edit is dropped and newer ones stay', () => {
    const { internals } = manager({ ownerRevisions: 3 });
    for (const id of ['a', 'b', 'c', 'd']) internals.recordOwnerRevision(id, revision);
    expect([...internals.ownerRevisions.keys()]).toEqual(['b', 'c', 'd']);
  });

  test('a settled call drops its pending owner edit', () => {
    const { permissions, internals } = manager({});
    internals.recordOwnerRevision('call-1', revision);
    permissions.retireAutonomousSource('call-1');
    expect(internals.ownerRevisions.has('call-1')).toBe(false);
  });

  test('settled claims are kept for the retention window, then the oldest is forgotten', () => {
    const { permissions, internals } = manager({ retiredClaims: 2 });
    for (const id of ['a', 'b', 'c']) { internals.autonomousClaims.add(id); permissions.retireAutonomousSource(id); }
    expect([...internals.autonomousClaims]).toEqual(['b', 'c']);
    // A claim that was never retired (call still running) is never forgotten.
    internals.autonomousClaims.add('live');
    for (const id of ['d', 'e']) { internals.autonomousClaims.add(id); permissions.retireAutonomousSource(id); }
    expect(internals.autonomousClaims.has('live')).toBe(true);
    expect(internals.autonomousClaims.has('b')).toBe(false);
  });
});
