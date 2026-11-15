import { gapAssessmentFixture } from './_helpers/knowledge-self-improvement-readings.js';
import { useKnowledgeAnswerReadings } from './_helpers/knowledge-answer-readings.js';
useKnowledgeAnswerReadings({ selfImprovement: [gapAssessmentFixture({ title: 'What ports does this device provide?' }, [], 0.99, 0.99)] });
import { describe, expect, spyOn, test } from 'bun:test';
import { upsertObservedKnowledgeNode } from '../platform/src/platform/knowledge/store-node-observation.js';
import { ACTIVE_REFINEMENT_STATES, knowledgeRefinementTaskLifecycle } from '../platform/src/platform/knowledge/types.js';
import { runKnowledgeSemanticSelfImprovement as improve } from '../platform/src/platform/knowledge/semantic/self-improvement.js';
import { recoverStaleActiveTasks } from '../platform/src/platform/knowledge/semantic/self-improvement-recovery.js';
import { upsertRefinementTaskForGap } from '../platform/src/platform/knowledge/semantic/self-improvement-tasks.js';
import { cancelHomeGraphRefinementTask } from '../platform/src/platform/knowledge/home-graph/refinement.js';
import { getHomeGraphStatus } from '../platform/src/platform/knowledge/home-graph/status.js';
import { createStores, useStoreCleanup } from './_helpers/knowledge-semantic-fixtures.js';

useStoreCleanup();

async function fixture() {
  const { store } = createStores();
  const spaceId = 'homeassistant:lifecycle-fixture';
  const source = await store.upsertSource({ id: 'manual', connectorId: 'manual', sourceType: 'document', title: 'Synthetic device manual', status: 'indexed', metadata: { knowledgeSpaceId: spaceId } });
  const gap = await upsertObservedKnowledgeNode(store, { id: 'manual-gap', kind: 'knowledge_gap', slug: 'manual-gap', title: 'What ports does this device provide?', status: 'active', confidence: 90, sourceId: source.id, metadata: { knowledgeSpaceId: spaceId, semanticKind: 'gap', gapKind: 'manual' } }, 'research-task', source, () => store.getSource(source.id));
  return { store, spaceId, source, gap };
}

describe('knowledge refinement task lifecycle', () => {
  test('a repair stopped by a memory-pressure pause does not stay in an active state', async () => {
    const { store, spaceId, gap } = await fixture();
    let paused = false;
    const result = await improve({ store, activeGapRepairs: new Set(), shouldStop: () => paused, gapRepairer: async () => {
      paused = true;
      return { searched: true, acceptedSourceIds: [], ingestedSourceIds: [], skippedUrls: [] };
    } }, { knowledgeSpaceId: spaceId, gapIds: [gap.id], force: true });
    const task = store.getRefinementTask(result.taskIds[0]!)!;
    expect(ACTIVE_REFINEMENT_STATES.has(task.state)).toBe(false);
    expect(task.state).toBe('blocked');
    expect(task.blockedReason).toContain('paused');
  });

  test('stale-task recovery leaves a repair this process is still running alone', async () => {
    const { store, spaceId, gap, source } = await fixture();
    const task = await upsertRefinementTaskForGap(store, spaceId, { gap, sources: [source], linkedObjects: [] }, 'scheduled', 'searching', 'Synthetic long search');
    const later = Date.now() + 60 * 60 * 1000;
    const clock = spyOn(Date, 'now').mockReturnValue(later);
    try {
      await recoverStaleActiveTasks(store, spaceId, (candidate) => candidate.id === task.id);
      expect(store.getRefinementTask(task.id)?.state).toBe('searching');
      await recoverStaleActiveTasks(store, spaceId);
      expect(store.getRefinementTask(task.id)?.state).toBe('blocked');
    } finally { clock.mockRestore(); }
  });

  test('cancelling a closed Home Graph task is refused with its current state', async () => {
    const { store, spaceId, gap, source } = await fixture();
    const task = await upsertRefinementTaskForGap(store, spaceId, { gap, sources: [source], linkedObjects: [] }, 'scheduled', 'closed', 'Synthetic closed repair');
    const result = await cancelHomeGraphRefinementTask({ store, knowledgeSpaceId: spaceId, taskId: task.id } as never);
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain('is closed, which is final');
    expect(store.getRefinementTask(task.id)?.state).toBe('closed');
  });

  test('the retired extracting and needs_review states are unreachable: not a target, not active, never reported as readiness', async () => {
    for (const dead of ['extracting', 'needs_review'] as const) {
      expect(knowledgeRefinementTaskLifecycle.can('detected', dead)).toBe(false);
      expect(ACTIVE_REFINEMENT_STATES.has(dead)).toBe(false);
    }
    const { store, spaceId, gap, source } = await fixture();
    await upsertRefinementTaskForGap(store, spaceId, { gap, sources: [source], linkedObjects: [] }, 'scheduled', 'blocked', 'Synthetic blocked repair');
    const status = await getHomeGraphStatus(store, { knowledgeSpaceId: spaceId } as never);
    expect(status.readiness.state).not.toBe('needs_review');
    expect(status.readiness.needsReviewTaskCount).toBe(0);
  });

  test('a repair abandoned by its caller stops reading as repairing once its task is stale', async () => {
    const { store, spaceId, gap, source } = await fixture();
    await upsertRefinementTaskForGap(store, spaceId, { gap, sources: [source], linkedObjects: [] }, 'scheduled', 'searching', 'Synthetic abandoned search');
    expect((await getHomeGraphStatus(store, { knowledgeSpaceId: spaceId } as never)).readiness.state).toBe('repairing');
    const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 60 * 60 * 1000);
    try {
      const status = await getHomeGraphStatus(store, { knowledgeSpaceId: spaceId } as never);
      expect(status.readiness.activeRefinementTaskCount).toBe(0);
      expect(status.readiness.state).not.toBe('repairing');
    } finally { clock.mockRestore(); }
  });
});
