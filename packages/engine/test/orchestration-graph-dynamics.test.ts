/**
 * graph-dynamics edge rules: a best-of-N group blocker is cycle-checked like any
 * other blocker, and conflict serialization only adds edges the dependency gate
 * actually enforces (items still waiting at the first phase).
 */
import { describe, expect, test } from 'bun:test';
import { addConflictSerializationEdges, addDependencyEdge } from '../platform/src/platform/orchestration/graph-dynamics.js';
import type { OrchestrationEvent, WorkItem, Workstream } from '../platform/src/platform/orchestration/types.js';

function item(id: string, extra: Partial<WorkItem> = {}): WorkItem {
  return {
    id, title: id, task: id, dependsOn: [], currentPhaseId: 'p1', state: 'pending',
    allAgentIds: [], visits: new Map(), touchedPaths: [], transportRetryCount: 0, createdAt: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    ...extra,
  } as unknown as WorkItem;
}

function workstream(items: WorkItem[]): Workstream {
  const phase = (id: string, ordinal: number) => ({ id, ordinal, role: 'engineer', capacity: 1, kind: 'engineer', gate: { scope: 'scoped', gates: [] } });
  return { id: 'ws', title: 'ws', phases: [phase('p2', 2), phase('p1', 1)], items } as unknown as Workstream;
}

describe('addDependencyEdge with a best-of-N group blocker', () => {
  test('refuses an edge onto a group that already waits on the item and emits graph-cycle', () => {
    const x = item('x');
    const a1 = item('a1', { attemptSourceId: 'G', dependsOn: ['x'] });
    const a2 = item('a2', { attemptSourceId: 'G', dependsOn: ['x'] });
    const ws = workstream([x, a1, a2]);
    const events: OrchestrationEvent[] = [];
    const result = addDependencyEdge(ws, 'x', 'G', 'discovered', (e) => events.push(e));
    expect(result.added).toBe(false);
    expect(result.cycle).toBeDefined();
    expect(x.dependsOn).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(['graph-cycle']);
  });

  test('still adds an edge onto a group that does not depend on the item', () => {
    const x = item('x');
    const a1 = item('a1', { attemptSourceId: 'G' });
    const ws = workstream([x, a1]);
    const result = addDependencyEdge(ws, 'x', 'G', 'discovered', () => {});
    expect(result.added).toBe(true);
    expect(x.dependsOn).toEqual(['G']);
  });
});

describe('addConflictSerializationEdges', () => {
  test('serializes an item waiting at the first phase and does not count an item past it', () => {
    const conflicted = item('a', { state: 'passed', files: ['src/m.ts'] });
    const first = item('b', { files: ['src/m.ts'] });
    const mid = item('c', { files: ['src/m.ts'], currentPhaseId: 'p2' });
    const ws = workstream([conflicted, first, mid]);
    const events: OrchestrationEvent[] = [];
    const added = addConflictSerializationEdges(ws, conflicted, ['src/m.ts'], (e) => events.push(e));
    expect(added).toBe(1);
    expect(first.dependsOn).toEqual(['a']);
    expect(mid.dependsOn).toEqual([]);
    expect(events.filter((e) => e.type === 'item-edge-added')).toHaveLength(1);
  });

  test('does not add an edge to an item parked on a budget block', () => {
    const conflicted = item('a', { files: ['src/m.ts'] });
    const parked = item('b', { files: ['src/m.ts'], state: 'blocked-budget' });
    const ws = workstream([conflicted, parked]);
    expect(addConflictSerializationEdges(ws, conflicted, ['src/m.ts'], () => {})).toBe(0);
    expect(parked.dependsOn).toEqual([]);
  });
});
