import { afterEach, expect, spyOn, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeSemanticService } from '../platform/src/platform/knowledge/semantic/service.js';
import { selfImprovementFixtureReading, gapAssessmentFixture } from './_helpers/knowledge-self-improvement-readings.js';
import { createStores, useStoreCleanup } from './_helpers/knowledge-semantic-fixtures.js';
import { seedKnowledgeResearchTask } from './_helpers/knowledge-semantic-activation-fixtures.js';

useStoreCleanup();

let previous: JudgmentPort | undefined;
let installed = false;
afterEach(() => { if (installed) installJudgmentPort(previous); installed = false; });

test('a failed gap repair waits out its retry window instead of being retried on the second run after', async () => {
  const fake = fakePort((name, question, state) => {
    const assessment = selfImprovementFixtureReading(name, question, state, [gapAssessmentFixture({ title: 'Synthetic device features' }, [], 0.99, 0.99)]);
    return assessment === undefined ? choiceAnswer(question, 'other', 0.99) : noulAnswer(assessment);
  });
  previous = installJudgmentPort(fake.port); installed = true;
  const { store } = createStores();
  const spaceId = 'knowledge:retry-window-fixture';
  const source = await store.upsertSource({ connectorId: 'fixture', sourceType: 'url', title: 'Synthetic device manual', status: 'indexed', metadata: { knowledgeSpaceId: spaceId } });
  const gap = await seedKnowledgeResearchTask(store, { kind: 'knowledge_gap', slug: 'synthetic-retry-gap', title: 'Synthetic device features', aliases: [], confidence: 50, sourceId: source.id,
    metadata: { knowledgeSpaceId: spaceId, semanticKind: 'gap', gapKind: 'answer', sourceIds: [source.id] } });
  let repairs = 0;
  const service = new KnowledgeSemanticService(store, { gapRepairer: async () => { repairs += 1; throw new Error('search provider refused the request'); } });

  await service.selfImprove({ knowledgeSpaceId: spaceId, gapIds: [gap.id], force: true });
  const failed = store.getNode(gap.id)!;
  expect(repairs).toBe(1);
  expect(failed.metadata.repairStatus).toBe('failed');
  const window = failed.metadata.nextRepairAttemptAt;
  expect(typeof window).toBe('number');

  await service.selfImprove({ knowledgeSpaceId: spaceId, gapIds: [gap.id] });
  await service.selfImprove({ knowledgeSpaceId: spaceId, gapIds: [gap.id] });
  const after = store.getNode(gap.id)!;
  expect(repairs).toBe(1);
  expect(after.metadata.repairStatus).toBe('failed');
  expect(after.metadata.nextRepairAttemptAt).toBe(window);

  // Once the window has passed the gap is attempted again.
  const clock = spyOn(Date, 'now').mockReturnValue((window as number) + 1);
  try { await service.selfImprove({ knowledgeSpaceId: spaceId, gapIds: [gap.id] }); }
  finally { clock.mockRestore(); }
  expect(repairs).toBe(2);
});
