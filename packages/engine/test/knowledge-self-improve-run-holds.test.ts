import { afterEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { KnowledgeSemanticService } from '../platform/src/platform/knowledge/semantic/service.js';
import { NO_REPAIRER_BLOCK, recoverNoRepairerTasks, recoverStaleActiveTasks } from '../platform/src/platform/knowledge/semantic/self-improvement-recovery.js';
import { buildGapContext } from '../platform/src/platform/knowledge/semantic/self-improvement-gap-context.js';
import { STALE_ACTIVE_TASK_MS } from '../platform/src/platform/knowledge/types.js';
import { gapAssessmentFixture, selfImprovementFixtureReading, type SelfImprovementFixtureValues } from './_helpers/knowledge-self-improvement-readings.js';
import { createStores, useStoreCleanup } from './_helpers/knowledge-semantic-fixtures.js';
import { seedKnowledgeResearchTask } from './_helpers/knowledge-semantic-activation-fixtures.js';

useStoreCleanup();

let previous: JudgmentPort | undefined;
let installed = false;
afterEach(() => { if (installed) installJudgmentPort(previous); installed = false; });

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };

/** Titles listed in `held` get an uncertain applicability reading; every other gap is read from the fixtures. */
function installReadings(fixtures: readonly SelfImprovementFixtureValues[], held: readonly string[] = []) {
  const fake = fakePort((name, question, state) => {
    const query = (state as { query?: unknown }).query;
    if (name === 'gapApplicable' && typeof query === 'string' && held.some((title) => query.includes(title))) return noulAnswer(0.5);
    const assessment = selfImprovementFixtureReading(name, question, state, fixtures);
    return assessment === undefined ? choiceAnswer(question, 'other', 0.99) : noulAnswer(assessment);
  });
  previous = installJudgmentPort(fake.port); installed = true;
  return fake;
}

async function seedGap(store: KnowledgeStore, spaceId: string, title: string, confidence: number, extra: Record<string, unknown> = {}) {
  const source = await store.upsertSource({ connectorId: 'fixture', sourceType: 'url', title: `${title} manual`, status: 'indexed', metadata: { knowledgeSpaceId: spaceId } });
  const gap = await seedKnowledgeResearchTask(store, { kind: 'knowledge_gap', slug: title.toLowerCase().replace(/\s+/g, '-'), title, aliases: [], confidence, sourceId: source.id,
    metadata: { knowledgeSpaceId: spaceId, semanticKind: 'gap', gapKind: 'answer', sourceIds: [source.id], ...extra } });
  return { source, gap };
}

const refusedRepair = (calls: string[]) => async (request: { readonly gaps: readonly { readonly title: string }[] }) => {
  calls.push(request.gaps[0]!.title);
  throw new Error('search provider refused the request');
};

describe('a gap whose model reading is held', () => {
  test('is reported in the run errors and the next gap is still repaired', async () => {
    installReadings([gapAssessmentFixture({ title: 'Beta device features' }, [], 0.99, 0.99)], ['Alpha device features']);
    const { store } = createStores();
    const space = 'knowledge:holds-one-space';
    const alpha = await seedGap(store, space, 'Alpha device features', 90);
    const beta = await seedGap(store, space, 'Beta device features', 50);
    const calls: string[] = [];
    const service = new KnowledgeSemanticService(store, { gapRepairer: refusedRepair(calls) });

    const result = await service.selfImprove({ knowledgeSpaceId: space, force: true });

    expect(result.errors.map((entry) => entry.gapId)).toContain(alpha.gap.id);
    expect(calls).toEqual(['Beta device features']);
    expect(store.getNode(beta.gap.id)?.metadata.repairStatus).toBe('failed');
    expect(store.getNode(alpha.gap.id)?.metadata.repairStatus).toBeUndefined();
  });

  test('does not stop a whole-store sweep from reaching the other spaces', async () => {
    installReadings([gapAssessmentFixture({ title: 'Beta device features' }, [], 0.99, 0.99)], ['Alpha device features']);
    const { store } = createStores();
    const alpha = await seedGap(store, 'knowledge:holds-sweep-a', 'Alpha device features', 90);
    await seedGap(store, 'knowledge:holds-sweep-b', 'Beta device features', 50);
    const calls: string[] = [];
    const service = new KnowledgeSemanticService(store, { gapRepairer: refusedRepair(calls) });

    const result = await service.selfImprove({ force: true });

    expect(calls).toEqual(['Beta device features']);
    expect(result.errors.some((entry) => entry.gapId === alpha.gap.id)).toBe(true);
  });
});

describe('a judgment port that never answers', () => {
  test('ends the gap at the run deadline instead of stalling the run', async () => {
    const hung = fakePort(() => new Promise<never>(() => {}));
    previous = installJudgmentPort(hung.port); installed = true;
    const { store } = createStores();
    const space = 'knowledge:holds-hung-port';
    const { gap } = await seedGap(store, space, 'Hung device features', 60);
    const calls: string[] = [];
    const service = new KnowledgeSemanticService(store, { gapRepairer: refusedRepair(calls) });

    const result = await service.selfImprove({ knowledgeSpaceId: space, force: true, maxRunMs: 50 });

    expect(calls).toEqual([]);
    expect(result.errors.map((entry) => entry.gapId)).toEqual([gap.id]);
    expect(result.skippedGaps).toBe(1);
  });
});

describe('a refinement task that is already final', () => {
  test('a suppressed task left by a run that stopped before the gap write finishes the gap on the next run', async () => {
    installReadings([gapAssessmentFixture({ title: 'Gamma device features' }, [], 0.01, 0.99)]);
    const { store } = createStores();
    const space = 'knowledge:holds-suppress';
    const { gap } = await seedGap(store, space, 'Gamma device features', 60);
    await store.upsertRefinementTask({ spaceId: space, gapId: gap.id, state: 'suppressed', trigger: 'manual', appendTrace: [] });
    const service = new KnowledgeSemanticService(store, { gapRepairer: refusedRepair([]) });

    const result = await service.selfImprove({ knowledgeSpaceId: space, gapIds: [gap.id], force: true });

    expect(result.suppressedGaps).toBe(1);
    expect(store.getNode(gap.id)?.status).toBe('stale');
    expect(store.getNode(gap.id)?.metadata.repairStatus).toBe('not_applicable');
  });

  test('a closed task for a gap that needs repair again is reported, not silently skipped or reopened', async () => {
    installReadings([gapAssessmentFixture({ title: 'Delta device features' }, [], 0.99, 0.99)]);
    const { store } = createStores();
    const space = 'knowledge:holds-closed';
    const { gap } = await seedGap(store, space, 'Delta device features', 60);
    const closed = await store.upsertRefinementTask({ spaceId: space, gapId: gap.id, state: 'closed', trigger: 'manual', appendTrace: [] });
    const calls: string[] = [];
    const service = new KnowledgeSemanticService(store, { gapRepairer: refusedRepair(calls) });

    const result = await service.selfImprove({ knowledgeSpaceId: space, gapIds: [gap.id], force: true });

    expect(calls).toEqual([]);
    expect(result.skippedGaps).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.gapId).toBe(gap.id);
    expect(result.errors[0]!.error).toContain(closed.id);
    expect(store.getRefinementTask(closed.id)?.state).toBe('closed');
  });
});

describe('a suppressed or cancelled task for a gap that needs repair', () => {
  for (const finalState of ['suppressed', 'cancelled'] as const) {
    test(`a ${finalState} task is reported, not silently skipped or reopened`, async () => {
      installReadings([gapAssessmentFixture({ title: `Zeta ${finalState} features` }, [], 0.99, 0.99)]);
      const { store } = createStores();
      const space = `knowledge:holds-${finalState}`;
      const { gap } = await seedGap(store, space, `Zeta ${finalState} features`, 60);
      const task = await store.upsertRefinementTask({ spaceId: space, gapId: gap.id, state: finalState, trigger: 'manual', appendTrace: [] });
      const calls: string[] = [];
      const service = new KnowledgeSemanticService(store, { gapRepairer: refusedRepair(calls) });

      const result = await service.selfImprove({ knowledgeSpaceId: space, gapIds: [gap.id], force: true });

      expect(calls).toEqual([]);
      expect(result.skippedGaps).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.error).toContain(task.id);
      expect(result.errors[0]!.error).toContain(finalState);
      expect(store.getRefinementTask(task.id)?.state).toBe(finalState);
    });
  }
});

describe('a second self-improvement run while one is active', () => {
  test('is reported as coalesced and truncated, never as an exhausted budget', async () => {
    installReadings([gapAssessmentFixture({ title: 'Epsilon device features' }, [], 0.99, 0.99)]);
    const { store } = createStores();
    const space = 'knowledge:holds-coalesce';
    await seedGap(store, space, 'Epsilon device features', 60);
    const started = deferred(); const release = deferred();
    const service = new KnowledgeSemanticService(store, { gapRepairer: async () => { started.resolve(); await release.promise; } });

    const first = service.selfImprove({ knowledgeSpaceId: space, force: true });
    await started.promise;
    const second = await service.selfImprove({ knowledgeSpaceId: space, force: true });
    release.resolve(); await first;

    expect(second.coalesced).toBe(true);
    expect(second.truncated).toBe(true);
    expect(second.budgetExhausted).toBe(false);
  });
});

describe('a refused run', () => {
  test('under critical memory pressure reports its reason without claiming the budget ran out', async () => {
    const { store } = createStores();
    const service = new KnowledgeSemanticService(store, { admitExpensiveWork: () => ({ allowed: false, reason: 'refused: daemon is under critical memory pressure' }) });
    const result = await service.selfImprove({ knowledgeSpaceId: 'knowledge:holds-refused' });
    expect(result.errors[0]!.error).toContain('critical memory pressure');
    expect(result.truncated).toBe(true);
    expect(result.budgetExhausted).toBe(false);
  });
});

describe('the repairer a run was started with', () => {
  test('is retired when the service is given another one mid-run', async () => {
    installReadings([gapAssessmentFixture({ title: 'Zeta device features' }, [], 0.99, 0.99)]);
    const { store } = createStores();
    const space = 'knowledge:holds-retired';
    const { gap } = await seedGap(store, space, 'Zeta device features', 60);
    const started = deferred(); const release = deferred();
    let signal: AbortSignal | undefined;
    const service = new KnowledgeSemanticService(store, { gapRepairer: async (request) => {
      signal = request.signal; started.resolve(); await release.promise;
      return { searched: true, evidenceSufficient: true, acceptedSourceIds: [], ingestedSourceIds: [], skippedUrls: [] };
    } });

    const run = service.selfImprove({ knowledgeSpaceId: space, gapIds: [gap.id], force: true });
    await started.promise;
    service.setGapRepairer(null);
    release.resolve();
    const result = await run;

    expect(signal).toBeDefined();
    // The retired repairer's late answer is not recorded as the outcome of a search.
    expect(store.getNode(gap.id)?.metadata.repairStatus).not.toBe('searched_no_sources');
    expect(result.searched).toBe(0);
  });
});

describe('recovery of tasks that were blocked for want of a repairer', () => {
  test('finds them by recorded kind, so rewording the message cannot strand them', async () => {
    const { store } = createStores();
    const space = 'knowledge:holds-recovery';
    const { gap } = await seedGap(store, space, 'Eta device features', 60, { repairStatus: 'no_repairer' });
    const task = await store.upsertRefinementTask({ spaceId: space, gapId: gap.id, state: 'blocked', trigger: 'manual', blockedReason: 'Reworded: nothing is configured to repair gaps.',
      metadata: { blockedKind: NO_REPAIRER_BLOCK }, appendTrace: [] });

    await recoverNoRepairerTasks(store, space);

    expect(store.getRefinementTask(task.id)?.state).toBe('detected');
    expect(store.getNode(gap.id)?.metadata.repairStatus).toBe('open');
  });

  test('a task the owner finished after the stale list was taken is left alone', async () => {
    const { store } = createStores();
    const space = 'knowledge:holds-stale-race';
    const { gap } = await seedGap(store, space, 'Theta device features', 60);
    const task = await store.upsertRefinementTask({ spaceId: space, gapId: gap.id, state: 'searching', trigger: 'manual', attemptCount: 2, appendTrace: [] });
    const batch = store.batch.bind(store);
    store.batch = async (operation) => {
      // The owner moves on between the list and the write-back.
      await store.upsertRefinementTask({ id: task.id, spaceId: space, gapId: gap.id, state: 'verified', trigger: 'manual', attemptCount: 3, appendTrace: [] });
      return batch(operation);
    };

    await recoverStaleActiveTasks(store, space, () => false, Date.now() + STALE_ACTIVE_TASK_MS * 2);

    expect(store.getRefinementTask(task.id)).toMatchObject({ state: 'verified', attemptCount: 3 });
  });
});

describe('ids saved on a gap', () => {
  test('that differ only in letter case name different sources', async () => {
    const { store } = createStores();
    const space = 'knowledge:holds-exact-ids';
    const upper = await store.upsertSource({ id: 'A1', connectorId: 'fixture', sourceType: 'url', title: 'Upper', status: 'indexed', metadata: { knowledgeSpaceId: space } });
    const lower = await store.upsertSource({ id: 'a1', connectorId: 'fixture', sourceType: 'url', title: 'Lower', status: 'indexed', metadata: { knowledgeSpaceId: space } });
    const gap = await seedKnowledgeResearchTask(store, { kind: 'knowledge_gap', slug: 'case-gap', title: 'Case gap', aliases: [], confidence: 50, sourceId: upper.id,
      metadata: { knowledgeSpaceId: space, semanticKind: 'gap', gapKind: 'answer', sourceIds: [upper.id, lower.id] } });

    const context = await buildGapContext(store, space, gap, []);

    expect(context.sources.map((source) => source.id).sort()).toEqual(['A1', 'a1']);
  });
});

describe('a refinement task cancelled while its repair is running', () => {
  test('the running repair stops: its result is not recorded and the task stays cancelled', async () => {
    installReadings([gapAssessmentFixture({ title: 'Epsilon device features' }, [], 0.99, 0.99)]);
    const { store } = createStores();
    const space = 'knowledge:holds-cancel-running';
    const { gap, source } = await seedGap(store, space, 'Epsilon device features', 60);
    let repairs = 0;
    const service = new KnowledgeSemanticService(store, {
      gapRepairer: async () => {
        repairs++;
        const running = store.listRefinementTasks(10, { spaceId: space }).find((task) => task.gapId === gap.id)!;
        expect(running.state).toBe('searching');
        await store.upsertRefinementTask({ id: running.id, spaceId: space, gapId: gap.id, state: 'cancelled', trigger: running.trigger, appendTrace: [] });
        return { searched: true, query: gap.title, acceptedSourceIds: [source.id], ingestedSourceIds: [source.id], skippedUrls: [], evidenceSufficient: true, reason: 'found' };
      },
    });

    const result = await service.selfImprove({ knowledgeSpaceId: space, gapIds: [gap.id], force: true });

    expect(repairs).toBe(1);
    const task = store.listRefinementTasks(10, { spaceId: space }).find((entry) => entry.gapId === gap.id)!;
    expect(task.state).toBe('cancelled');
    expect(task.trace.map((entry) => entry.state)).not.toContain('evaluating');
    expect(result.closedGaps).toBe(0);
    expect(result.linkedRepairs).toBe(0);
    expect(store.getNode(gap.id)?.metadata.repairStatus).toBeUndefined();
  });
});
