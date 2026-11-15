import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import type { CommandContext } from '../../input/command-registry.ts';
import type { MemoryRecord } from '@goodvibes-jev/engine/platform/platform/state';
import { learningCuratorSummary } from '../../tools/agent-harness-learning-curator.ts';
import { consolidationCandidatesForDomain } from '../../tools/agent-harness-learning-curator-consolidation.ts';
import type { LearningRecord } from '../../tools/agent-harness-learning-curator-source.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner } from '../helpers/research-screening.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(async () => { installJudgmentPort(previous); await cleanupResearchScreeningFixtures(); });
const options = () => ({ sourceOwner: ordinaryResearchOwner() });

function record(id: string, name: string, reviewState = 'reviewed'): LearningRecord {
  return { item: { id, name, description: 'A synthetic complete learning record.', reviewState, source: 'user', tags: [], triggers: [] },
    record: { id, name, procedure: 'The complete synthetic procedure.', provenance: 'native fixture' } };
}

/** Every pair reads as the same entity, with the given confidence; the survivor is always the first record. */
function sameEverywhere(confidence = 0.9999) {
  return fakePort((name, question) => {
    if (question.type === 'score') return scoreAnswer(question, 2, confidence);
    if (question.type === 'noul') return noulAnswer(name.startsWith('item_') ? 0.0001 : 0.9999);
    return choiceAnswer(question, '0', confidence);
  });
}

test('a staged duplicate stays in its group for deletion but is never the survivor or staged again', async () => {
  const readings = sameEverywhere(); installJudgmentPort(readings.port);
  const candidates = await consolidationCandidatesForDomain('skill',
    [record('a', 'Release'), record('b', 'Release'), record('c', 'Release', 'stale')], options());
  expect(candidates).toHaveLength(1);
  const plan = candidates[0]?.consolidation;
  expect(plan?.survivorId).toBe('a');
  expect(plan?.duplicateIds).toEqual(['b', 'c']);
  expect(plan?.staleDuplicateIds).toEqual(['c']);
});

test('with one live record left the survivor is that record and no survivor reading is made', async () => {
  const readings = sameEverywhere(); installJudgmentPort(readings.port);
  const candidates = await consolidationCandidatesForDomain('skill', [record('a', 'Release', 'stale'), record('b', 'Release')], options());
  expect(candidates[0]?.consolidation?.survivorId).toBe('b');
  expect(candidates[0]?.consolidation?.staleDuplicateIds).toEqual(['a']);
  expect(readings.requests.filter(request => Object.hasOwn(request.questions, 'pick') || Object.keys(request.questions).some(name => name.startsWith('item_')))).toHaveLength(0);
});

test('a group made only of staged records proposes nothing', async () => {
  const readings = sameEverywhere(); installJudgmentPort(readings.port);
  expect(await consolidationCandidatesForDomain('skill', [record('a', 'Release', 'stale'), record('b', 'Release', 'stale')], options())).toEqual([]);
});

test('a pair whose reading is not settled proposes nothing and does not fail the read', async () => {
  const readings = sameEverywhere(0.5); installJudgmentPort(readings.port);
  expect(await consolidationCandidatesForDomain('skill', [record('a', 'Release'), record('b', 'Release')], options())).toEqual([]);
});

test('the curator plan offers no merge step when no candidate carries survivor fields', async () => {
  const memory = (id: string): MemoryRecord => ({ id, summary: 'Same stored statement', detail: 'The exact synthetic durable claim and complete provenance.',
    tags: [], provenance: [], scope: 'project', cls: 'fact', reviewState: 'fresh', confidence: 90, createdAt: 1, updatedAt: 1 });
  const native = { clients: { agentKnowledgeApi: { memory: { getAll: () => [memory('one'), memory('two')] } } } };
  installJudgmentPort(fakePort((name, question) => {
    if (question.type === 'score') return scoreAnswer(question, name === 'link' ? 2 : 3, 0.9999);
    if (question.type === 'noul') return noulAnswer(name.startsWith('item_') ? 0.0001 : 0.9999);
    return choiceAnswer(question, name === 'memory_class' ? 'decision' : name === 'target' ? 'memory' : '0', 0.9999);
  }).port);
  const report = await learningCuratorSummary(native as unknown as CommandContext, { includeParameters: true, query: 'consolidation' }, options()) as {
    consolidationBatch?: { phases: { id: string }[]; topCandidates: { previewRoute: string; mergeRoute?: string; stalePhaseRoute: string }[] } };
  const batch = report.consolidationBatch;
  expect(batch?.topCandidates.length).toBeGreaterThan(0);
  expect(batch?.phases.map(phase => phase.id)).not.toContain('merge-survivor');
  for (const candidate of batch?.topCandidates ?? []) {
    expect(candidate.mergeRoute).toBeUndefined();
    expect(candidate.previewRoute).toContain('mode:"preview"');
    expect(candidate.stalePhaseRoute).toContain('mode:"stale"');
  }
});
