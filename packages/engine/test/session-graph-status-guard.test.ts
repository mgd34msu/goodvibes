import { describe, expect, test } from 'bun:test';
import { SessionTaskGraph } from '../platform/src/platform/sessions/orchestration/graph.ts';
import type { CrossSessionTaskRef } from '../platform/src/platform/sessions/orchestration/types.ts';
import type { TaskLifecycleState } from '../platform/src/platform/runtime/store/domains/tasks.ts';

function graphWith(status: TaskLifecycleState): SessionTaskGraph {
  const graph = new SessionTaskGraph();
  const ref: CrossSessionTaskRef = { sessionId: 's', taskId: 't', title: 't', status, createdAt: 1, updatedAt: 1 };
  graph.upsertRef(ref);
  return graph;
}

describe('session task graph propagateStatus honours the task lifecycle', () => {
  test('a settled ref does not move to running or completed', () => {
    for (const settled of ['completed', 'failed', 'cancelled'] as const) {
      const graph = graphWith(settled);
      expect(graph.propagateStatus('s', 't', 'running')).toBe(false);
      expect(graph.getRef('s', 't')?.status).toBe(settled);
    }
    const graph = graphWith('completed');
    expect(graph.propagateStatus('s', 't', 'failed')).toBe(false);
    expect(graph.getRef('s', 't')?.status).toBe('completed');
  });

  test('legal moves and the retry re-queue still apply', () => {
    const graph = graphWith('queued');
    expect(graph.propagateStatus('s', 't', 'running')).toBe(true);
    expect(graph.propagateStatus('s', 't', 'failed')).toBe(true);
    expect(graph.propagateStatus('s', 't', 'queued')).toBe(true);
    expect(graph.getRef('s', 't')?.status).toBe('queued');
    expect(graphWith('running').propagateStatus('s', 't', 'queued')).toBe(true);
    // an unobserved intermediate state is not a refusal
    expect(graphWith('queued').propagateStatus('s', 't', 'completed')).toBe(true);
  });
});
