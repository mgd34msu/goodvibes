import { describe, expect, test } from 'bun:test';
import type { CommandContext } from '../../input/command-registry.ts';
import { memoryRefinementCatalogStatus } from '../../tools/agent-harness-memory-refinement.ts';

function contextWithStates(states: readonly string[]): CommandContext {
  const tasks = states.map((state, index) => ({ id: `task-${index}`, spaceId: 'agent', state, trace: [], createdAt: 1, updatedAt: 1 }));
  return { extensions: { agentKnowledgeService: { listRefinementTasks: () => tasks } } } as unknown as CommandContext;
}

describe('memory refinement task counts', () => {
  test('only queued or in-progress repair counts as active, matching Home Graph status', () => {
    const status = memoryRefinementCatalogStatus(contextWithStates(['detected', 'verified', 'searching']));
    expect(status.taskCounts).toMatchObject({ total: 3, active: 1 });
  });

  test('a store with only detected tasks reads as ready, not active', () => {
    expect(memoryRefinementCatalogStatus(contextWithStates(['detected'])).status).toBe('ready');
  });
});
