import { describe, expect, test } from 'bun:test';
import { blockedFleetNotices } from '../platform/src/platform/control-plane/routes/register-gateway-verb-groups.ts';
import type { FleetSnapshot, ProcessNode } from '../platform/src/platform/runtime/fleet/types.ts';

function registryOf(nodes: Array<Partial<ProcessNode>>): { query(): FleetSnapshot } {
  return { query: () => ({ nodes } as unknown as FleetSnapshot) };
}

describe('blocked fleet notices', () => {
  test('only nodes waiting on the operator become notices, carrying reason, label, kind and session', () => {
    const notices = blockedFleetNotices(registryOf([
      { id: 'a', kind: 'agent', label: 'builder', state: 'thinking' },
      { id: 'b', kind: 'agent', label: 'reviewer', state: 'thinking', needsAttention: { reason: 'approval' }, sessionRef: { sessionId: 's-1' } },
      { id: 'c', kind: 'workflow', label: 'merge', state: 'thinking', needsAttention: { reason: 'conflict' } },
    ]));
    expect(notices).toEqual([
      { type: 'FLEET_NODE_BLOCKED_ON_USER', nodeId: 'b', label: 'reviewer', reason: 'approval', sessionId: 's-1', kind: 'agent' },
      { type: 'FLEET_NODE_BLOCKED_ON_USER', nodeId: 'c', label: 'merge', reason: 'conflict', kind: 'workflow' },
    ]);
  });
});
